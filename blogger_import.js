
module.exports = function BloggerImportModule(pb) {
    
    /**
     * Blogger Import: import a Blogger blog's content into PencilBlue
     *
     */
    function BloggerImport(){}

    /**
     * Called when the application is being installed for the first time.
     *
     * @param cb A callback that must be called upon completion.  cb(err, result).
     * The result is ignored
     */
    BloggerImport.onInstall = function(cb) {
        cb(null, true);
    };

    /**
     * Called when the application is uninstalling this plugin.  The plugin should
     * make every effort to clean up any plugin-specific DB items or any in function
     * overrides it makes.
     *
     * @param cb A callback that must be called upon completion.  cb(err, result).
     * The result is ignored
     */
    BloggerImport.onUninstall = function(cb) {
        var result = pb.AdminSubnavService.unregisterFor('plugin_settings', BloggerImport.onPluginSettingsSubNav);
        cb(null, result);
    };

    /**
     * Called when the application is starting up. The function is also called at
     * the end of a successful install. It is guaranteed that all core PB services
     * will be available including access to the core DB.
     *
     * @param cb A callback that must be called upon completion.  cb(err, result).
     * The result is ignored
     */
    BloggerImport.onStartup = function(cb) {
        var result = pb.AdminSubnavService.registerFor('plugin_settings', BloggerImport.onPluginSettingsSubNav);
        cb(null, result);
    };

    /**
     *
     * @static
     * @method onPluginSettingsSubNav
     * @param {String} navKey
     * @param {Localization}
     * @param {Object} The plugin object
     * @return {Array}
     */
    BloggerImport.onPluginSettingsSubNav = function(navKey, localization, plugin) {
        if(plugin.uid === 'blogger_import') {
            return [
                {
                    name: 'import_xml',
                    title: 'Import Blogger XML',
                    icon: 'upload',
                    href: '/admin/plugins/blogger_import/settings/import'
                }
            ];
        }
        return [];
    };

    /**
     * Called when the application is gracefully shutting down.  No guarantees are
     * provided for how much time will be provided the plugin to shut down.
     *
     * @param cb A callback that must be called upon completion.  cb(err, result).
     * The result is ignored
     */
    BloggerImport.onShutdown = function(cb) {
        cb(null, true);
    };

    //exports
    return BloggerImport;
};
