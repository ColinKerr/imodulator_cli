# manifest download Command details

Implementation details for the `imod hub manifest download` command.

Downloads the raw manifest file into the cache directory for the iModel and returns the path to the manifest file.  The command checks to see if the manifest is already downloaded and if it is up to date before downloading a new one.  If the manifest is cached and up to date, just return the path to the existing file.  If the manifest is cached but not up to date either return a message to that extent or, if the `--update` flag is passed, update the cached version.