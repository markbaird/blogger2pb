/*
    Copyright (C) 2015  PencilBlue, LLC

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

//dependencies
var process = require('process');
var async   = require('async');
var domain  = require('domain');

module.exports = function BloggerXMLParseServiceModule(pb) {
    
    //pb dependencies
    var util           = pb.util;
    var xml2js         = pb.PluginService.require('blogger_import', 'xml2js');
    var BaseController = pb.BaseController;

    /**
     *
     * @class BloggerXMLParseService
     * @constructor
     */
    function BloggerXMLParseService() {}
    
    /**
     * Counter used to help create a random values for required fields when no 
     * value is present
     * @private
     * @static
     * @property DEFAULT_COUNTER
     * @type {Integer}
     */
    var DEFAULT_COUNTER = 0;

    /**
     * @static
     * @method init
     */
    BloggerXMLParseService.init = function(cb) {
        pb.log.debug("BloggerXMLParseService: Initialized");
        cb(null, true);
    };

    BloggerXMLParseService.parse = function(xmlString, defaultUserId, cb) {
        var self = this;
        pb.log.debug('BloggerXMLParseService: Starting to parse...');

        xml2js.parseString(xmlString, function(err, bloggerData) {
            if(err) {
                return cb('^loc_INVALID_XML^');
            }

            var feed = bloggerData.feed;

            var settings = null;
            var users = null;
            var topics = null;
            var tasks = [

                //load settings
                function(callback) {
                    var pluginService = new pb.PluginService();
                    pluginService.getSettingsKV('blogger_import', function(err, settingsResult) {
                        settings = settingsResult;
                        callback(err);
                    });
                },

                function(callback) {
                    self.saveNewUsers(feed, settings, function(err, usersResult){
                        users = usersResult;
                        callback(err);
                    });
                },

                function(callback) {
                    self.saveNewTopics(feed, function(err, topicsResult) {
                        topics = topicsResult;
                        callback(err);
                    });
                },

                function(callback) {
                    self.saveNewArticlesAndPages(defaultUserId, feed, users, topics, settings, callback);
                }
            ];
            async.series(tasks, function(err, results) {
                cb(err, users);
            });
        });
    };

    BloggerXMLParseService.saveNewUsers = function(feed, settings, cb) {
        pb.log.debug('BloggerXMLParseService: Parsing Users...');

        var self = this;
        var users = [];
        var createNewUsers = settings.create_new_users;
        if(createNewUsers && util.isArray(feed.entry)) {
            for(var i = 0; i < feed.entry.length; i++) {
                var userMatch = false;
                for(var s = 0; s < users.length; s++) {
                    if(users[s].username === feed.entry[i]['author']['name'][0]) {
                        userMatch = true;
                        break;
                    }
                }
                if(!userMatch) {
                    users.push({username: feed.entry[i]['author']['name'][0]});
                }
            }
        }

        var tasks = util.getTasks(users, function(users, index) {
            return function(callback) {

                var dao = new pb.DAO();
                dao.loadByValue('username', users[index].username, 'user', function(err, existingUser) {
                    if (util.isError(err)) {
                        return cb(err);
                    }
                    else if(existingUser) {
                        pb.log.debug('BloggerXMLParseService: User [%s] already exists', users[index].username);

                        users[index] = existingUser;
                        delete users[index].password;
                        return callback(null, existingUser);
                    }

                    var generatedPassword = pb.security.generatePassword(8);

                    users[index].email = 'user_' + util.uniqueId() + '@placeholder.com';
                    users[index].admin = pb.SecurityService.ACCESS_WRITER;
                    users[index].password = generatedPassword;

                    var newUser = pb.DocumentCreator.create('user', users[index]);
                    dao.save(newUser, function(err, result) {
                        if (util.isError(err)) {
                            return callback(err);
                        }

                        pb.log.debug('BloggerXMLParseService: Created user [%s]', users[index].username);
                        delete users[index].password;
                        users[index].generatedPassword = generatedPassword;
                        users[index][pb.DAO.getIdField()] = result[pb.DAO.getIdField()];
                        callback(null, newUser);
                    });
                });
            };
        });
        async.series(tasks, cb);
    };

    BloggerXMLParseService.saveNewTopics = function(feed, cb) {
        pb.log.debug('BloggerXMLParseService: Parsing topics...');

        //parse out the list of topics to try and persist
        var topics = {};

        pb.log.silly('BloggerXMLParseService:Parsing Topics: Inspecting category elements...');

        var entries = feed["entry"];

        // iterate over the entries
        for (var e = 0; e < entries.length; e++) {

            var categories = entries[e]["category"];
            if (util.isArray(categories)) {

                //iterate over the categories
                for(var i = 0; i < categories.length; i++) {

                    //get the topic name
                    var rawName = categories[i].$.term;
                    if (rawName.indexOf("http://schemas.google.com/blogger") == 0)
                        continue;  // Skip Blogger schema elements

                    var topicName = pb.BaseController.sanitize(rawName.trim());

                    //when it doesn't exist
                    var lower = topicName.toLowerCase();
                    if(!topics[lower] && lower !== 'uncategorized') {

                        topics[lower] = {
                            name: topicName
                        };
                    }
                }
            }
        }

        //persist each tag if it doesn't already exist
        var tasks = util.getTasks(Object.keys(topics), function(topicKeys, i) {
            return function(callback) {

                //get the topic formatted
                var topic = pb.DocumentCreator.create('topic', topics[topicKeys[i]]);

                //ensure it doesn't already exist
                var key = 'name';
                var val = new RegExp('^'+util.escapeRegExp(topic.name)+'$', 'ig');
                var dao = new pb.DAO();
                dao.loadByValue(key, val, 'topic', function(err, existingTopic) {
                    if (util.isError(err)) {
                        return callback(err);   
                    }
                    else if(existingTopic) {
                        pb.log.debug("BloggerXMLParseService: Topic %s already exists. Skipping", topic.name);
                        return callback(null, existingTopic);
                    }

                    //we're all good.  we can persist now
                    dao.save(topic, callback);
                });
            };
        });
        async.parallel(tasks, cb);
    };

    BloggerXMLParseService.saveNewArticlesAndPages = function(defaultUserId, feed, users, topics, settings, cb) {
        var self = this;
        var rawArticles = [];
        var rawPages = [];
        var articles = [];
        var pages = [];
        var media = [];


        pb.log.debug('BloggerXMLParseService: Parsing Articles and Pages...');

        //parse out the articles and pages
        var entries = feed["entry"];
        for(var i = 0; i < entries.length; i++) {
            var postType = entries[i]["category"];

            //pb.log.info("BloggerXMLParseService: PostType: %s", postType);
            if (postType) {

                if(postType[0].$.term === 'http://schemas.google.com/blogger/2008/kind#page') {
                    if (entries[i]['content'][0]._)
                        rawPages.push(entries[i]);
                }
                else if(postType[0].$.term === 'http://schemas.google.com/blogger/2008/kind#post') {
                    if (entries[i]['content'][0]._)
                        rawArticles.push(entries[i]);
                }
            }
        }

        pb.log.info("BloggerXMLParseService: Found [%d] pages and [%d] articles.", rawPages.length, rawArticles.length);

        //page tasks
        var pageTasks = util.getTasks(rawPages, function(rawPages, index) {
            return function(callback) {
                var rawPage = rawPages[index];
                var pageName = rawPage["title"][0]._;

                //output progress
                pb.log.info('BloggerXMLParseService: Processing %s %s', 'page', pageName);

                var url = pageName;
                var links = rawPage["link"];
                for (var i = 0; i < links.length; i++) {
                    if (links[i].$.rel == "alternate") {
                        url = links[i].$.href.substr(links[i].$.href.lastIndexOf("/"));
                        pb.log.info('BloggerXMLParseService: Found URL "%s" for page "%s"', url, pageName);
                        break;
                    }
                }
                pb.log.info('BloggerXMLParseService: No URL found for page %s', pageName);

                //check to see if the page already exists by URL
                var options = {
                    type: 'page',
                    url: url
                };
                var urlService = new pb.UrlService();
                urlService.existsForType(options, function(err, exists) {
                    if (util.isError(err)) {
                        return callback(err);
                    }
                    else if (exists) {
                        pb.log.debug('A %s with this URL [%s] already exists.  Skipping', options.type, pageName);
                        return callback();
                    }

                    //look for associated topics
                    var pageTopics = [];
                    var categories = rawPage["category"];
                    for(var i = 0; i < categories.length; i++) {
                        //get the topic name
                        var rawName = categories[i].$.term;
                        if (rawName.indexOf("http://schemas.google.com/blogger") == 0)
                            continue;  // Skip Blogger schema elements

                        if(util.isString(rawName)) {
                            for(var j = 0; j < topics.length; j++) {
                                if(topics[j].name == rawName) {
                                    pageTopics.push(topics[j][pb.DAO.getIdField()].toString());
                                }
                            }
                        }
                    }

                    //retrieve media content for page
                    pb.log.info('BloggerXMLParseService: Inspecting %s for media content', pageName);

                    self.retrieveMediaObjects(rawPage['content'][0]._, settings, function(err, updatedContent, mediaObjects) {
                        if (util.isError(err)) {
                            pb.log.error('BloggerXMLParseService: Failed to retrieve 1 or more media objects for %s. %s', options.type, err.stack);
                        }
                        updatedContent = updatedContent.split("\r\n").join("<br/>");

                        //create page media references
                        var pageMedia = [];
                        if (util.isArray(mediaObjects)) {
                            for(var i = 0; i < mediaObjects.length; i++) {
                                pb.log.info('BloggerXMLParseService: Adding media object %s', mediaObjects[i]);

                                pageMedia.push(mediaObjects[i][pb.DAO.getIdField()].toString());
                            }
                        }

                        //construct the page descriptor
                        var title = BaseController.sanitize(rawPage["title"][0]._) || BloggerXMLParseService.uniqueStrVal('Page');
                        var pagedoc = {
                            url: pageName,
                            headline: title,
                            publish_date: new Date(rawPage['published'][0]),
                            page_layout: BaseController.sanitize(updatedContent, BaseController.getContentSanitizationRules()),
                            page_topics: pageTopics,
                            page_media: pageMedia,
                            seo_title: title,
                            author: defaultUserId
                        }
                        pb.log.info('BloggerXMLParseService: Saving page %s', pagedoc);

                        var newPage = pb.DocumentCreator.create('page', pagedoc);
                        var dao = new pb.DAO();
                        dao.save(newPage, callback);
                    });
                });
            };
        });

        //article tasks
        var articleTasks = util.getTasks(rawArticles, function(rawArticles, index) {
            return function(callback) {
                var rawArticle = rawArticles[index];
                var articleName = rawArticle["title"][0]._;

                if (util.isNullOrUndefined(articleName) || articleName === '') {
                    articleName = BloggerXMLParseService.uniqueStrVal('article');
                };

                //output progress
                pb.log.debug('BloggerXMLParseService: Processing %s "%s"', 'article', articleName);

                var url = articleName;
                var links = rawArticle["link"];
                for (var i = 0; i < links.length; i++) {
                    if (links[i].$.rel == "alternate") {
                        url = links[i].$.href.substr(links[i].$.href.lastIndexOf("/"));
                        pb.log.info('BloggerXMLParseService: Found URL "%s" for article "%s"', url, articleName);
                        break;
                    }
                }
                pb.log.info('BloggerXMLParseService: No URL found for article %s', articleName);

                //check to see if the page already exists by URL
                var options = {
                    type: 'article',
                    url: url
                };
                var urlService = new pb.UrlService();
                urlService.existsForType(options, function(err, exists) {
                    if (util.isError(err)) {
                        return callback(err);
                    }
                    else if (exists) {
                        pb.log.debug('BloggerXMLParseService: A %s with this URL [%s] already exists.  Skipping', options.type, articleName);
                        return callback();
                    }

                    //look for associated topics
                    var articleTopics = [];
                    var categories = rawArticle["category"];
                    for(var i = 0; i < categories.length; i++) {
                        //get the topic name
                        var rawName = categories[i].$.term;
                        if (rawName.indexOf("http://schemas.google.com/blogger") == 0)
                            continue;  // Skip Blogger schema elements

                        var topicName = pb.BaseController.sanitize(rawName.trim());
                        var found = false;
                        for(var j = 0; j < topics.length; j++) {
                            if(topics[j].name == topicName) {
                                articleTopics.push(topics[j][pb.DAO.getIdField()].toString());
                                found = true;
                                break;
                            }
                        }

                        if (!found) {
                            pb.log.error('BloggerXMLParseService: Unable to associate topic [%s] with article [%s]', topicName, articleName);
                        }
                    }

                    //lookup author
                    var author;
                    var authorUsername = rawArticle["author"][0]["name"][0];
                    for(i = 0; i < users.length; i++) {
                        if(users[i].username === authorUsername) {
                            author = users[i][pb.DAO.getIdField()].toString();
                        }
                    }
                    if(!author) {
                        author = defaultUserId;
                    }

                    //retrieve media content for article
                    pb.log.debug('BloggerXMLParseService: Inspecting %s for media content', articleName);

                    self.retrieveMediaObjects(rawArticle['content'][0]._, settings, function(err, updatedContent, mediaObjects) {
                        if (util.isError(err)) {
                            pb.log.error('BloggerXMLParseService: Failed to retrieve 1 or more media objects for %s. %s', options.type, err.stack);
                        }
                        updatedContent = updatedContent.split("\r\n").join("<br/>");

                        //create page media references
                        var articleMedia = [];
                        if (util.isArray(mediaObjects)) {
                            for(var i = 0; i < mediaObjects.length; i++) {
                                articleMedia.push(mediaObjects[i][pb.DAO.getIdField()].toString());
                            }
                        }

                        //construct the article descriptor
                        var title = BaseController.sanitize(rawArticle["title"][0]._) || BloggerXMLParseService.uniqueStrVal('Article');
                        var articleDoc = {
                            url: articleName,
                            headline: title,
                            publish_date: new Date(rawArticle['published'][0]),
                            article_layout: BaseController.sanitize(updatedContent, BaseController.getContentSanitizationRules()),
                            article_topics: articleTopics,
                            article_sections: [],
                            article_media: articleMedia,
                            seo_title: title,
                            author: author
                        };

                        if (articleMedia) {
                            // TODO: key off media:thumbnail element if present
                            articleDoc.thumbnail = articleMedia[0];
                        }

                        pb.log.info('BloggerXMLParseService: Saving article %s', articleDoc);

                        var newArticle = pb.DocumentCreator.create('article', articleDoc);
                        var dao = new pb.DAO();
                        dao.save(newArticle, callback);
                    });
                });
            };
        });

        //create a super set of tasks and execute them 1 at a time
        var tasks = articleTasks.concat(pageTasks);
        pb.log.info("BloggerXMLParseService: Now processing %d pages and %d articles.", pageTasks.length, articleTasks.length);
        async.series(tasks, cb);
    };

    BloggerXMLParseService.retrieveMediaObjects = function(content, settings, cb) {

        var handlers = [
            {
                name: 'image',
                hasContent: function() {
                    return content.indexOf('<img') > -1;
                },
                getContentDetails: function() {
                    var startIndex = content.indexOf('<img');
                    var endIndex1 = content.substr(startIndex).indexOf('/>');
                    var endIndex2 = content.substr(startIndex).indexOf('/img>');
                    var endIndex3 = content.substr(startIndex).indexOf('>');

                    var endIndex;
                    if(endIndex1 > -1 && endIndex1 < endIndex2) {
                        endIndex = endIndex1 + 2;
                    }
                    else if(endIndex2 > -1) {
                        endIndex = endIndex2 + 4;
                    }
                    else {
                        endIndex = endIndex3 + 1;
                    }

                    var mediaString = content.substr(startIndex, endIndex);
                    var srcString = mediaString.substr(mediaString.indexOf('src="') + 5);
                    srcString = srcString.substr(0, srcString.indexOf('"'));
                    if(srcString.indexOf('?') > -1) {
                        srcString = srcString.substr(0, srcString.indexOf('?'));
                    }

                    var altString = "";
                    if (mediaString.indexOf('alt="') > -1) {
                        mediaString.substr(mediaString.indexOf('alt="') + 5);
                        altString = altString.substr(0, srcString.indexOf('"'));
                    }

                    return {
                        source: srcString,
                        replacement: mediaString,
                        caption: altString
                    };
                },
                getMediaObject: function(details, cb) {
                    if(!settings.download_media) {
                        return BloggerXMLParseService.createMediaObject('image', details.source, details.caption, cb);
                    }

                    //download it & store it with the media service
                    BloggerXMLParseService.downloadMediaContent(details.source, function(err, location) {
                        if (util.isError(err)) {
                            return cb(err);   
                        }

                        //create the media object
                        BloggerXMLParseService.createMediaObject('image', location, details.caption, cb);
                    });
                }
            }
        ];

        var handler;
        var mediaObjects = [];
        var whileFunc = function() {

            //reset the handler and search for the next piece of content by asking 
            //which handler can find conent.
            handler = null;
            for (var i = 0; i < handlers.length; i++) {
                if (handlers[i].hasContent()) {

                    handler = handlers[i];
                    break;
                }
            }
            return handler !== null;
        };
        var doFunc = function(callback) {

            //extract the source string and string in content to be replaced
            var details = handler.getContentDetails();
            pb.log.debug("BloggerXMLParseService: Discovered media type [%s] with source [%s] and replacement [%s]", handler.name, details.source, details.replacement);

            //retrieve media object
            handler.getMediaObject(details, function(err, mediaObj) {
                if (util.isError(err)) {
                    pb.log.error('BloggerXMLParseService: Failed to create media object. Source: [%s] Replacement: [%s]. %s', details.source, details.replacement, err.stack); 
                }
                if (!mediaObj) {

                    //we couldn't get the media for whatever reason but we'll leave 
                    //you a nice note to manually fix it.
                    content = content.replace(details.replacement, util.format("[Content: %s Goes Here]", details.source));
                    return callback();
                }

                //persist the media descriptor
                var mediaService = new pb.MediaService();
                mediaService.save(mediaObj, function(err, results) {
                    if (util.isError(err)) {
                        return callback(err);
                    }

                    //do the final replacement with the correctly formatted template engine flag
                    mediaObjects.push(mediaObj);
                    content = content.replace(details.replacement, util.format('^media_display_%s/position:center^', mediaObj[pb.DAO.getIdField()]));
                    callback();
                });
            });
        };
        async.whilst(whileFunc, doFunc, function(err){
            cb(err, content, mediaObjects);
        });
    };

    BloggerXMLParseService.createMediaObject = function(mediaType, location, caption, cb) {

        var options = {
            where: {
                location: location
            },
            limit: 1
        };
        var mediaService = new pb.MediaService();
        mediaService.get(options, function(err, mediaArray) {
            if (util.isError(err)) {
                return cb(err);   
            }
            else if(mediaArray.length > 0) {
                return cb(null, mediaArray[0]);
            }

            var isFile = location.indexOf('/media') === 0;
            var mediadoc = {
                is_file: isFile,
                media_type: mediaType,
                location: location,
                thumb: location,
                name: 'Media_' + util.uniqueId(),
                caption: caption,
                media_topics: []
            };

            //persist the 
            var newMedia = pb.DocumentCreator.create('media', mediadoc);
            cb(null, newMedia);
        });
    };

    BloggerXMLParseService.downloadMediaContent = function(srcString, cb) {
        if (util.isNullOrUndefined(srcString) || srcString.indexOf('http') !== 0) {
            return cb(new Error('Invalid protocol on URI: '+srcString));
        }
        
        //only load the modules into memory if we really have to.  Footprint isn't 
        //much but it all adds up
        var ht = srcString.indexOf('https://') >= 0 ? require('https') : require('http');

        //create a function to download the content
        var run = function() {
            ht.get(srcString, function(res) {
                BloggerXMLParseService.saveMediaContent(srcString, res, cb);
            });
        };

        //wrapper the whole thing in a domain to protect it from timeouts and other 
        //crazy network errors.
        var d = domain.create();
        d.once('error', function(err) {
            cb(err);
        });
        d.on('error', function(err) {/* generic handler so we catch any continuous errors */});
        d.run(function() {
            process.nextTick(run);
        });
    };

    BloggerXMLParseService.saveMediaContent = function(originalFilename, stream, cb) {
        var mediaService = new pb.MediaService();
        mediaService.setContentStream(stream, originalFilename, function(err, result) {
            cb(err, result ? result.mediaPath : null);
        });
    };
    
    BloggerXMLParseService.uniqueStrVal = function(prefix) {
        return prefix + '-' + (DEFAULT_COUNTER++) + '-' + (new Date()).getTime();
    };

    //exports
    return BloggerXMLParseService;
};
