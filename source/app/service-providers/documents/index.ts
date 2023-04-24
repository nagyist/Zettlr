/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        DocumentManager
 * CVM-Role:        Controller
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This controller represents all open files that are displayed
 *                  in the app. It will stay in sync with the configuration's
 *                  open files setting and emit events as necessary. The
 *                  renderer's equivalent is the editor and the tabs.
 *
 * END HEADER
 */

import EventEmitter from 'events'
import path from 'path'
import { promises as fs, constants as FSConstants } from 'fs'
import { FSALCodeFile, FSALFile } from '@providers/fsal'
import ProviderContract from '@providers/provider-contract'
import broadcastIpcMessage from '@common/util/broadcast-ipc-message'
import type AppServiceContainer from 'source/app/app-service-container'
import { ipcMain, app } from 'electron'
import { DocumentTree, type DTLeaf } from './document-tree'
import PersistentDataContainer from '@common/modules/persistent-data-container'
import { type TabManager } from '@providers/documents/document-tree/tab-manager'
import { DP_EVENTS, type OpenDocument, DocumentType } from '@dts/common/documents'
import { v4 as uuid4 } from 'uuid'
import chokidar from 'chokidar'
import { type Update } from '@codemirror/collab'
import { ChangeSet, Text } from '@codemirror/state'
import type { CodeFileDescriptor, MDFileDescriptor } from '@dts/common/fsal'
import { countChars, countWords } from '@common/util/counter'
import { markdownToAST } from '@common/modules/markdown-utils'
import { DocumentAuthoritySingleton } from './document-authority'

type DocumentWindows = Record<string, DocumentTree>

export default class DocumentManager extends ProviderContract {
  /**
   * This array holds all open windows, here represented as document trees
   *
   * @var {DocumentTree[]}
   */
  private readonly _windows: DocumentWindows
  /**
   * The event emitter helps broadcast events across the main process
   *
   * @var {EventEmitter}
   */
  private readonly _emitter: EventEmitter
  /**
   * The config file container persists the document tree data to disk so that
   * open editor panes & windows can be restored
   *
   * @var {PersistentDataContainer}
   */
  private readonly _config: PersistentDataContainer
  /**
   * The process that watches currently opened files for remote changes
   *
   * @var {chokidar.FSWatcher}
   */
  private readonly _watcher: chokidar.FSWatcher

  /**
   * Holds a list of strings for files that have recently been saved by the
   * user. For those files, we need to ignore remote changes since they
   * originate here.
   *
   * @var {string[]}
   */
  private readonly _ignoreChanges: string[]

  constructor (private readonly _app: AppServiceContainer) {
    super()

    const containerPath = path.join(app.getPath('userData'), 'documents.yaml')

    this._windows = {}
    this._emitter = new EventEmitter()
    this._config = new PersistentDataContainer(containerPath, 'yaml')
    this._ignoreChanges = []
    this._remoteChangeDialogShownFor = []

    const options: chokidar.WatchOptions = {
      persistent: true,
      ignoreInitial: true, // Do not track the initial watch as changes
      followSymlinks: true, // Follow symlinks
      ignorePermissionErrors: true, // In the worst case one has to reboot the software, but so it looks nicer.
      // See the description for the next vars in the fsal-watchdog.ts
      interval: 5000,
      binaryInterval: 5000
    }

    if (this._app.config.get('watchdog.activatePolling') as boolean) {
      let threshold: number = this._app.config.get('watchdog.stabilityThreshold')
      if (typeof threshold !== 'number' || threshold < 0) {
        threshold = 1000
      }

      // From chokidar docs: "[...] in some cases some change events will be
      // emitted while the file is being written." --> hence activate this.
      options.awaitWriteFinish = {
        stabilityThreshold: threshold,
        pollInterval: 100
      }

      this._app.log.info(`[DocumentManager] Activating file polling with a threshold of ${threshold}ms.`)
    }

    // Start up the chokidar process
    this._watcher = new chokidar.FSWatcher(options)

    this._watcher.on('all', (event: string, filePath: string) => {
      this._app.log.info(`[DocumentManager] Processing ${event} for ${filePath}`)
      if (this._ignoreChanges.includes(filePath)) {
        this._ignoreChanges.splice(this._ignoreChanges.indexOf(filePath), 1)
        return
      }

      if (event === 'unlink') {
        // Close the file everywhere
        this.closeFileEverywhere(filePath)
      } else if (event === 'change') {
        this.handleRemoteChange(filePath).catch(err => console.error(err))
      } else {
        this._app.log.warning(`[DocumentManager] Received unexpected event ${event} for ${filePath}.`)
      }
    })

    /**
     * Hook the event listener that directly communicates with the editors
     */
    ipcMain.handle('documents-authority', async (event, { command, payload }) => {
      const authority = this.documentAuthority
      switch (command) {
        case 'pull-updates':
          return await authority.pullUpdates(payload.filePath, payload.version)
        case 'push-updates':
          return await authority.pushUpdates(payload.filePath, payload.version, payload.updates)
        case 'get-document':
          return await authority.getDocument(payload.filePath)
      }
    })

    // Finally, listen to events from the renderer
    ipcMain.handle('documents-provider', async (event, { command, payload }) => {
      switch (command) {
        // A given tab should be set as pinned
        case 'set-pinned': {
          const windowId = payload.windowId as string
          const leafID = payload.leafId as string
          const filePath = payload.path as string
          const shouldBePinned = payload.pinned as boolean
          this.setPinnedStatus(windowId, leafID, filePath, shouldBePinned)
          return
        }
        // Some main window has requested its tab/split view state
        case 'retrieve-tab-config': {
          return this._windows[payload.windowId].toJSON()
        }
        case 'save-file': {
          const filePath = payload.path as string
          return await this.saveFile(filePath)
        }
        case 'open-file': {
          return await this.openFile(payload.windowId, payload.leafId, payload.path, payload.newTab)
        }
        case 'close-file': {
          const leafId = payload.leafId as string
          const windowId = payload.windowId as string
          const filePath = payload.path as string
          return await this.closeFile(windowId, leafId, filePath)
        }
        case 'sort-open-files': {
          const leafId = payload.leafId as string
          const windowId = payload.windowId as string
          const newOrder = payload.newOrder as string[]
          this.sortOpenFiles(windowId, leafId, newOrder)
          return
        }
        case 'get-file-modification-status': {
          return this.documentAuthority.getModifiedDocumentPaths()
        }
        case 'move-file': {
          const oWin = payload.originWindow
          const tWin = payload.targetWindow
          const oLeaf = payload.originLeaf
          const tLeaf = payload.targetLeaf
          const filePath = payload.path
          return await this.moveFile(oWin, tWin, oLeaf, tLeaf, filePath)
        }
        case 'split-leaf': {
          const oWin = payload.originWindow
          const oLeaf = payload.originLeaf
          const direction = payload.direction
          const insertion = payload.insertion
          const filePath = payload.path // Optional, may be undefined
          const fromWindow = payload.fromWindow // Optional, may be undefined
          const fromLeaf = payload.fromLeaf // Optional, may be undefined
          return await this.splitLeaf(oWin, oLeaf, direction, insertion, filePath, fromWindow, fromLeaf)
        }
        case 'close-leaf': {
          return this.closeLeaf(payload.windowId, payload.leafId)
        }
        case 'set-branch-sizes': {
          // NOTE that in this particular instance we do not emit an event. The
          // reason is that we need to prevent frequent reloads during resizing.
          // For as long as the window is open, the window will have the correct
          // sizes, and will only update those sizes here in the main process.
          // As soon as the window is closed, however, it will automatically
          // grab the correct sizes again.
          const branch = this._windows[payload.windowId].findBranch(payload.branchId)
          if (branch !== undefined) {
            branch.sizes = payload.sizes
            this.syncToConfig()
          }
          return
        }
        case 'navigate-forward': {
          return await this.navigateForward(payload.windowId, payload.leafId)
        }
        case 'navigate-back': {
          return await this.navigateBack(payload.windowId, payload.leafId)
        }
      }
    })
  }

  /**
   * Use this method to ask the user whether or not the window identified with
   * the windowId may be closed. If this function returns true, the user agreed
   * to drop all changes, or there were no changes contained in the window.
   *
   * @param   {string}            windowId  The window in question
   *
   * @return  {Promise<boolean>}            Returns false if the window may not be closed
   */
  public async askUserToCloseWindow (windowId: string): Promise<boolean> {
    return true
  }

  async boot (): Promise<void> {
    // Loads in all openFiles
    this._app.log.verbose('Document Manager starting up ...')

    // Ensure the document authority is ready as soon as clients begin
    // requesting files. NOTE: For this it suffices to just access it.
    this.documentAuthority.on('onBeforeUnlinkFile', (filePath: string) => {
      this.closeFileEverywhere(filePath)
    })

    // Check if the data store is initialized
    if (!await this._config.isInitialized()) {
      this._app.log.info('[Document Manager] Initializing document storage ...')
      const tree = new DocumentTree()
      const key = uuid4()
      await this._config.init({ [key]: tree.toJSON() })
    }

    const treedata: DocumentWindows = await this._config.get()
    for (const key in treedata) {
      try {
        // Make sure to fish out invalid paths before mounting the tree
        const tree = DocumentTree.fromJSON(treedata[key])
        for (const leaf of tree.getAllLeafs()) {
          for (const file of leaf.tabMan.openFiles.map(x => x.path)) {
            try {
              await fs.access(file, FSConstants.F_OK|FSConstants.W_OK|FSConstants.R_OK)
            } catch (err: any) {
              leaf.tabMan.closeFile(file)
            }
          }
          if (leaf.tabMan.openFiles.length === 0) {
            leaf.parent.removeNode(leaf)
          }
        }
        this._windows[key] = tree
        this.broadcastEvent(DP_EVENTS.NEW_WINDOW, { key })
      } catch (err: any) {
        this._app.log.error(`[Document Provider] Could not instantiate window ${key}: ${err.message as string}`, err)
      }
    }

    if (Object.keys(treedata).length === 0) {
      this._app.log.warning('[Document Manager] Creating new window since all are closed.')
      const key = uuid4()
      this._windows[key] = new DocumentTree()
      this.broadcastEvent(DP_EVENTS.NEW_WINDOW, { key })
    }

    // Sync everything after boot
    this.syncWatchedFilePaths()
    await this.synchronizeDatabases()
    this.syncToConfig()

    this._app.log.info(`[Document Manager] Restored ${this.windowCount()} open windows.`)
  }

  public windowCount (): number {
    return Object.keys(this._windows).length
  }

  public windowKeys (): string[] {
    return Object.keys(this._windows)
  }

  public leafIds (windowId: string): string[] {
    if (!(windowId in this._windows)) {
      return []
    }

    return this._windows[windowId].getAllLeafs().map(leaf => leaf.id)
  }

  public newWindow (): void {
    const newTree = new DocumentTree()
    const existingKeys = Object.keys(this._windows)
    let key = uuid4()
    while (existingKeys.includes(key)) {
      key = uuid4()
    }

    this._windows[key] = newTree
    this.broadcastEvent(DP_EVENTS.NEW_WINDOW, { key })
    this.syncToConfig()
  }

  public closeWindow (windowId: string): void {
    if (this._shuttingDown) {
      return // During shutdown only the WindowManager should close windows
    }

    const isLastWindow = Object.values(this._windows).length === 1

    if (windowId in this._windows && !isLastWindow) {
      // NOTE: By doing this, we always retain the window state of the last and
      // only window that is open. This means that, while additional windows
      // will be forgotten after closing, the last and final one will always
      // retain its state.
      // TODO: If we ever implement workspaces, etc., this safeguard won't be
      // necessary anymore.
      this._app.log.info(`[Documents Manager] Closing window ${windowId}!`)
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete this._windows[windowId]
      this.syncToConfig()
    }
  }

  // Enable global event listening to updates of the config
  on (evt: string, callback: (...args: any[]) => void): void {
    this._emitter.on(evt, callback)
  }

  once (evt: string, callback: (...args: any[]) => void): void {
    this._emitter.once(evt, callback)
  }

  // Also do the same for the removal of listeners
  off (evt: string, callback: (...args: any[]) => void): void {
    this._emitter.off(evt, callback)
  }

  async shutdown (): Promise<void> {
    // We MUST under all circumstances properly call the close() function on
    // every chokidar process we utilize. Otherwise, the fsevents dylib will
    // still hold on to some memory after the Electron process itself shuts down
    // which will result in a crash report appearing on macOS.
    await this._watcher.close()
    this._config.shutdown()
  }

  private broadcastEvent (event: DP_EVENTS, context?: any): void {
    // Here we blast an event notification across every line of code of the app
    broadcastIpcMessage('documents-update', { event, context })
    this._emitter.emit(event, context)
  }

  /**
   * This function searches all currently opened documents for files that have
   * databases attached to them, and announces to the citeproc provider that it
   * should keep those available. Resolves once the citeproc provider finishes
   * synchronizing.
   */
  private async synchronizeDatabases (): Promise<void> {
    const libraries: string[] = []

    for (const doc of this.documents) {
      if (doc.descriptor.type !== 'file') {
        continue
      }

      if (doc.descriptor.frontmatter !== null && 'bibliography' in doc.descriptor.frontmatter) {
        const bib = doc.descriptor.frontmatter.bibliography
        if (typeof bib === 'string' && path.isAbsolute(bib)) {
          libraries.push(bib)
        }
      }
    }

    await this._app.citeproc.synchronizeDatabases(libraries)
  }

  /**
   * Returns a file's metadata including the contents.
   *
   * @param  {string}  file   The absolute file path
   * @param  {boolean} newTab Optional. If true, will always prevent exchanging the currently active file.
   *
   * @return {Promise<MDFileDescriptor|CodeFileDescriptor>} The file's descriptor
   */
  public async openFile (windowId: string, leafId: string|undefined, filePath: string, newTab?: boolean, modifyHistory?: boolean): Promise<boolean> {
    const avoidNewTabs = Boolean(this._app.config.get('system.avoidNewTabs'))
    let leaf: DTLeaf|undefined
    if (leafId === undefined) {
      // Take the first leaf of the given window
      leaf = this._windows[windowId].getAllLeafs()[0]
    } else {
      leaf = this._windows[windowId].findLeaf(leafId)
    }

    if (leaf === undefined) {
      return false
    }

    // Now we definitely know the leaf ID if it was undefined
    if (leafId === undefined) {
      leafId = leaf.id
    }

    if (leaf.tabMan.openFiles.map(x => x.path).includes(filePath)) {
      // File is already open -> simply set it as active
      // leaf.tabMan.activeFile = filePath
      leaf.tabMan.openFile(filePath)
      this.broadcastEvent(DP_EVENTS.ACTIVE_FILE, { windowId, leafId, filePath })
      return true
    }

    // TODO: Make sure the active file is not modified!
    // Close the (formerly active) file if we should avoid new tabs and have not
    // gotten a specific request to open it in a *new* tab
    const activeFile = leaf.tabMan.activeFile
    const ret = leaf.tabMan.openFile(filePath)

    if (activeFile !== null && avoidNewTabs && newTab !== true && !this.isModified(activeFile.path)) {
      leaf.tabMan.closeFile(activeFile)
      this.syncWatchedFilePaths()
      this.broadcastEvent(DP_EVENTS.CLOSE_FILE, { windowId, leafId, filePath })
      this.broadcastEvent(DP_EVENTS.ACTIVE_FILE, { windowId, leafId, filePath: leaf.tabMan.activeFile?.path })
    }
    if (ret) {
      this.broadcastEvent(DP_EVENTS.OPEN_FILE, { windowId, leafId, filePath })
    }

    this.broadcastEvent(DP_EVENTS.ACTIVE_FILE, { windowId, leafId, filePath: leaf.tabMan.activeFile?.path })
    await this.synchronizeDatabases()
    this.syncToConfig()
    return ret
  }

  /**
   * Closes the given file if it's in fact open. This function deals with every
   * potential problem such as retrieving user consent to closing the file if it
   * is modified.
   *
   * @param   {MDFileDescriptor|CodeFileDescriptor}  file  The file to be closed
   *
   * @return  {boolean}                                    Whether or not the file was closed
   */
  public async closeFile (windowId: string, leafId: string, filePath: string): Promise<boolean> {
    const leaf = this._windows[windowId].findLeaf(leafId)
    if (leaf === undefined) {
      this._app.log.error(`[Document Manager] Could not close file ${filePath}: Editor pane not found.`)
      return false
    }

    let numOpenInstances = 0
    await this.forEachLeaf(async tabMan => {
      const file = tabMan.openFiles.find(f => f.path === filePath)
      if (file !== undefined) {
        numOpenInstances++
      }
      return false
    })

    // If we were to completely remove the file from our buffer, we have to ask
    // first. If there's at least another instance open that means that we won't
    // lose the file. NOTE: openFile will be undefined if the file has not been
    // opened in this session of Zettlr, hence it will not be modified, hence we
    // don't have to do anything.
    const openFile = this.documents.find(doc => doc.filePath === filePath)
    if (openFile !== undefined && this.isModified(filePath) && numOpenInstances === 1) {
      const result = await this._app.windows.askSaveChanges()
      // 0 = Save, 1 = Don't save, 2 = Cancel
      if (result.response === 1) {
        // Clear the modification flag
        openFile.lastSavedVersion = openFile.currentVersion
      } else if (result.response === 0) {
        await this.saveFile(filePath) // TODO: Check return status
      } else {
        // Don't close the file
        this._app.log.info('[Document Manager] Not closing file, as the user did not want that.')
        return false
      }

      // Remove the file
      this.documents.splice(this.documents.indexOf(openFile), 1)
    }

    const ret = leaf.tabMan.closeFile(filePath)
    if (ret) {
      this.syncToConfig()
      this.syncWatchedFilePaths()
      this.broadcastEvent(DP_EVENTS.CLOSE_FILE, { windowId, leafId, filePath })
      this.broadcastEvent(DP_EVENTS.ACTIVE_FILE, { windowId, leafId, filePath: leaf.tabMan.activeFile?.path })
      if (leaf.tabMan.openFiles.length === 0) {
        // Remove this leaf
        leaf.parent.removeNode(leaf)
        this.broadcastEvent(DP_EVENTS.LEAF_CLOSED, { windowId, leafId })
        this.syncToConfig()
      }

      await this.synchronizeDatabases()
    }
    return ret
  }

  /**
   * Directs every open leaf to close a given file. This function even
   * overwrites potential stati such as modification or pinned to ensure files
   * are definitely closed. Call this function if a file has been removed from
   * disk.
   *
   * @param   {string}  filePath  The file path in question
   */
  public closeFileEverywhere (filePath: string): void {
    for (const key in this._windows) {
      const allLeafs = this._windows[key].getAllLeafs()
      for (const leaf of allLeafs) {
        if (leaf.tabMan.openFiles.map(x => x.path).includes(filePath)) {
          leaf.tabMan.setPinnedStatus(filePath, false)
          const success = leaf.tabMan.closeFile(filePath)
          if (success) {
            this.broadcastEvent(DP_EVENTS.CLOSE_FILE, { windowId: key, leafId: leaf.id, filePath })
          }
        }
      }
    }
  }

  /**
   * This function can be called from within the FSAL or programmatically, if a
   * file has been programmatically been moved (either by renaming or moving).
   * This makes it easier for the user to not even notice this inside the open
   * documents.
   *
   * @param  {string}  oldPath  The old path
   * @param  {string}  newPath  The path it'll be afterwards
   */
  public async hasMovedFile (oldPath: string, newPath: string): Promise<void> {
    // Basically we just have to close the oldPath, and "open" the new path.
    const openDoc = this.documents.find(doc => doc.filePath === oldPath)
    if (openDoc === undefined) {
      return // Nothing to do
    }

    openDoc.filePath = newPath
    openDoc.descriptor.path = newPath
    openDoc.descriptor.dir = path.dirname(newPath)
    openDoc.descriptor.name = path.basename(newPath)
    openDoc.descriptor.ext = path.extname(newPath)

    const leafsToNotify: Array<[string, string]> = []
    await this.forEachLeaf(async (tabMan, windowId, leafId) => {
      const res = tabMan.replaceFilePath(oldPath, newPath)
      if (res) {
        leafsToNotify.push([ windowId, leafId ])
      }
      return res
    })

    this.syncWatchedFilePaths()

    // Emit the necessary events to each window
    for (const [ windowId, leafId ] of leafsToNotify) {
      this.broadcastEvent(DP_EVENTS.CLOSE_FILE, { filePath: oldPath, windowId, leafId })
      this.broadcastEvent(DP_EVENTS.OPEN_FILE, { filePath: newPath, windowId, leafId })
    }
  }

  /**
   * Convenience function, can be called in case of moving a directory around.
   * Will internally call hasMovedFile for every affected file to ensure a
   * smooth user experience.
   *
   * @param  {string}  oldPath  The old path
   * @param  {string}  newPath  The new path
   */
  public async hasMovedDir (oldPath: string, newPath: string): Promise<void> {
    // Similar as hasMovedFile, but triggers the command for every affected file
    const docs = this.documents.filter(doc => doc.filePath.startsWith(oldPath))

    for (const doc of docs) {
      this._app.log.info('Replacing file path for doc ' + doc.filePath + ' with ' + doc.filePath.replace(oldPath, newPath))
      await this.hasMovedFile(doc.filePath, doc.filePath.replace(oldPath, newPath))
    }
  }

  /**
   * Returns all open files
   *
   * @return  {string[]}  An array of absolute file paths
   */
  public getOpenFiles (): string[] {
    const openFiles: string[] = []
    for (const windowId in this._windows) {
      for (const leaf of this._windows[windowId].getAllLeafs()) {
        openFiles.push(...leaf.tabMan.openFiles.map(f => f.path))
      }
    }

    return [...new Set(openFiles)] // Remove duplicates
  }

  /**
   * This function ensures that our watcher keeps watching the correct files
   */
  private syncWatchedFilePaths (): void {
    // First, get the files currently watched
    const watchedFiles: string[] = []
    const watched = this._watcher.getWatched()
    for (const dir in watched) {
      for (const filename of watched[dir]) {
        watchedFiles.push(path.join(dir, filename))
      }
    }

    const openFiles = this.getOpenFiles()

    // Third, remove those watched files which are no longer open
    for (const watchedFile of watchedFiles) {
      if (!openFiles.includes(watchedFile)) {
        this._watcher.unwatch(watchedFile)
      }
    }

    // Fourth, add those open files not yet watched
    for (const openFile of openFiles) {
      if (!watchedFiles.includes(openFile)) {
        this._watcher.add(openFile)
      }
    }
  }

  /**
   * This is a convenience function meant for operations that affect every
   * editor pane across the whole application, such as renaming files, removing
   * directories, and other things. It will iterate over every open editor pane
   * and call the provided callback function, providing the tab manager for the
   * pane in question. Since some operations require async, the whole function
   * works asynchronously.
   *
   * The callback function MUST return a boolean indicating whether the state of
   * any pane has changed. If it has, the function will make sure to emit
   * appropriate events. If you do not honor this, any changes to the internal
   * state will not be picked up by the appropriate places.
   *
   * @param   {(tabMan: TabManager) => Promise<boolean>}  callback  The callback
   */
  public async forEachLeaf (callback: (tabMan: TabManager, windowId: string, leafId: string) => Promise<boolean>): Promise<void> {
    for (const windowId in this._windows) {
      for (const leaf of this._windows[windowId].getAllLeafs()) {
        const stateHasChanged = await callback(leaf.tabMan, windowId, leaf.id)
        if (stateHasChanged) {
          this.syncToConfig()
        }
      }
    }
  }

  /**
   * This method synchronizes the state of the loadedDocuments array into the
   * configuration. It also makes sure to announce changes to whomever it may
   * concern.
   */
  private syncToConfig (): void {
    const toSave: any = {}
    for (const key in this._windows) {
      toSave[key] = this._windows[key].toJSON()
    }
    this._config.set(toSave)
  }

  /**
   * Sets the pinned status for the given file.
   *
   * @param   {string}   filePath        The absolute path to the file
   * @param   {boolean}  shouldBePinned  Whether the file should be pinned.
   */
  private setPinnedStatus (windowId: string, leafId: string, filePath: string, shouldBePinned: boolean): void {
    const leaf = this._windows[windowId].findLeaf(leafId)
    if (leaf === undefined) {
      return
    }

    leaf.tabMan.setPinnedStatus(filePath, shouldBePinned)
    this.broadcastEvent(DP_EVENTS.CHANGE_FILE_STATUS, { windowId, leafId, filePath, status: 'pinned' })
    this.syncToConfig()
  }

  /**
   * Broadcasts a remote changed event across the app to notify everyone that a
   * file has been remotely changed.
   *
   * @param {string} filePath The file in question
   */
  public async notifyRemoteChange (filePath: string): Promise<void> {
    // Here we basically only need to close the document and wait for the
    // renderers to reload themselves with getDocument, which will automatically
    // open the new document.
    const idx = this.documents.findIndex(file => file.filePath === filePath)
    this.documents.splice(idx, 1)
    // Indicate to all affected editors that they should reload the file
    this.broadcastEvent(DP_EVENTS.FILE_REMOTELY_CHANGED, filePath)
  }

  /**
   * Sets the given descriptor as active file.
   *
   * @param {MDFileDescriptor|CodeFileDescriptor|null} descriptorPath The descriptor to make active file
   */
  public setActiveFile (windowId: string, leafId: string, filePath: string|null): void {
    const leaf = this._windows[windowId].findLeaf(leafId)
    if (leaf === undefined) {
      return
    }

    leaf.tabMan.activeFile = filePath
    this.broadcastEvent(DP_EVENTS.ACTIVE_FILE, { windowId, leafId, filePath })
    this.syncToConfig()
  }

  public sortOpenFiles (windowId: string, leafId: string, newOrder: string[]): void {
    const leaf = this._windows[windowId].findLeaf(leafId)
    if (leaf === undefined) {
      return
    }

    const res = leaf.tabMan.sortOpenFiles(newOrder)
    if (res) {
      this.broadcastEvent(DP_EVENTS.FILES_SORTED, { windowId, leafId })
      this.syncToConfig()
    }
  }

  /**
   * Using this function, one can move a given file from one editor pane to
   * another -- even across windows.
   *
   * @param {number} originWindow The originating window
   * @param {number} targetWindow The target window
   * @param {string} originLeaf   The origin pane in the origin window
   * @param {string} targetLeaf   The target pane in the target window
   * @param {string} filePath     The file to be moved
   */
  public async moveFile (
    originWindow: string,
    targetWindow: string,
    originLeaf: string,
    targetLeaf: string,
    filePath: string
  ): Promise<void> {
    // The user has requested to move a file. This basically just means closing
    // the file in the origin, and opening it in the target
    const origin = this._windows[originWindow].findLeaf(originLeaf)
    const target = this._windows[targetWindow].findLeaf(targetLeaf)

    if (origin === undefined || target === undefined) {
      this._app.log.error(`[Document Manager] Received a move request from ${originLeaf} to ${targetLeaf} but one of those was undefined.`)
      return
    }

    // First open the file in the target
    let success = target.tabMan.openFile(filePath)
    if (success) {
      this.broadcastEvent(DP_EVENTS.OPEN_FILE, { windowId: targetWindow, leafId: targetLeaf, filePath })
      this.broadcastEvent(DP_EVENTS.ACTIVE_FILE, { windowId: targetWindow, leafId: targetLeaf })
      this.syncToConfig()
    }

    // Then decide if we should close the leaf ...
    if (origin.tabMan.openFiles.length === 1) {
      // Close the leaf instead
      this.closeLeaf(originWindow, originLeaf)
      this.syncToConfig()
    } else {
      // ... or rather just close the file
      success = origin.tabMan.closeFile(filePath)
      if (!success) {
        this._app.log.error(`[Document Manager] Could not fulfill move request for file ${filePath}: Could not close it.`)
        return
      }

      this.broadcastEvent(DP_EVENTS.CLOSE_FILE, { windowId: originWindow, leafId: originLeaf, filePath })
      this.broadcastEvent(DP_EVENTS.ACTIVE_FILE, { windowId: originWindow, leafId: originLeaf })
      this.syncToConfig()
    }
  }

  /**
   * Splits the given origin leaf along the direction. Optionally, you can also
   * direct the document manager to immediately move a file from the origin to
   * the to-be-created leaf to fill it with content.
   *
   * @param {number} originWindow   The originating window
   * @param {string} originLeaf     The origin pane in the origin window
   * @param {string} splitDirection The direction of the split (horizontal or vertical)
   * @param {string} insertion      Where to insert the new leaf (defaults to after)
   * @param {string} filePath       Optional: the file to be moved
   * @param {number} fromWindow     Optional: If the file doesn't come from origin
   * @param {string} fromLeaf       Optional: If the file doesn't come from origin
   */
  public async splitLeaf (
    originWindow: string,
    originLeaf: string,
    splitDirection: 'horizontal'|'vertical',
    insertion: 'before'|'after' = 'after',
    filePath?: string,
    fromWindow?: string,
    fromLeaf?: string
  ): Promise<void> {
    // The user has requested a split and following move of a file
    const origin = this._windows[originWindow].findLeaf(originLeaf)

    if (origin === undefined) {
      this._app.log.error(`[Document Manager] Received a split request from ${originLeaf} but could not find it.`)
      return
    }

    const target = origin.split(splitDirection, insertion)
    this.broadcastEvent(DP_EVENTS.NEW_LEAF, {
      windowId: originWindow,
      originLeaf,
      newLeaf: target.id,
      direction: splitDirection,
      insertion
    })

    this.syncToConfig()

    if (filePath !== undefined) {
      const win = (fromWindow !== undefined) ? fromWindow : originWindow
      const leaf = (fromLeaf !== undefined) ? fromLeaf : originLeaf
      await this.moveFile(win, originWindow, leaf, target.id, filePath)
    }
  }

  public closeLeaf (windowId: string, leafId: string): void {
    const leaf = this._windows[windowId].findLeaf(leafId)

    if (leaf !== undefined) {
      leaf.parent.removeNode(leaf)
      this.broadcastEvent(DP_EVENTS.LEAF_CLOSED, { windowId, leafId })
    }
  }

  /**
   * Returns the hash of the currently active file.
   * @returns {number|null} The hash of the active file.
   */
  public getActiveFile (leafId: string): string|null {
    for (const windowId in this._windows) {
      const leaf = this._windows[windowId].findLeaf(leafId)
      if (leaf !== undefined) {
        return leaf.tabMan.activeFile?.path ?? null
      }
    }
    return null
  }

  public isModified (filePath: string): boolean {
    return this.documentAuthority.isModified(filePath)
  }

  /**
   * Retrieves the document authority singleton
   *
   * @return  {DocumentAuthoritySingleton}  The singleton
   */
  private get documentAuthority (): DocumentAuthoritySingleton {
    return DocumentAuthoritySingleton.getInstance(this._app.fsal)
  }

  /**
   * Returns true if none of the open files have their modified flag set.
   *
   * @param  {string|number}  leafId  Can either contain a leafId or a window
   *                                  index, and returns the clean state only
   *                                  for that. If undefined, returns the total
   *                                  clean state.
   */
  public isClean (id?: string, which?: 'window'|'leaf'): boolean {
    const modPaths = this.documentAuthority.getModifiedDocumentPaths()

    if (id === undefined) {
      // Total clean state
      return modPaths.length === 0
    } else if (which === 'window') {
      // window-specific clean state
      const allLeafs = this._windows[id].getAllLeafs()
      for (const leaf of allLeafs) {
        for (const file of leaf.tabMan.openFiles) {
          if (modPaths.includes(file.path)) {
            return false
          }
        }
      }
    } else {
      // leaf-specific clean state
      for (const key in this._windows) {
        const leaf = this._windows[key].findLeaf(id)
        if (leaf !== undefined) {
          for (const file of leaf.tabMan.openFiles) {
            if (modPaths.includes(file.path)) {
              return false
            }
          }
        }
      }
    }

    return true
  }

  public async navigateForward (windowId: string, leafId: string): Promise<void> {
    const leaf = this._windows[windowId].findLeaf(leafId)
    if (leaf === undefined) {
      return
    }

    leaf.tabMan.forward()
    this.broadcastEvent(DP_EVENTS.OPEN_FILE, { windowId, leafId })
    this.broadcastEvent(DP_EVENTS.ACTIVE_FILE, { windowId, leafId })
  }

  public async navigateBack (windowId: string, leafId: string): Promise<void> {
    const leaf = this._windows[windowId].findLeaf(leafId)
    if (leaf === undefined) {
      return
    }

    leaf.tabMan.back()
    this.broadcastEvent(DP_EVENTS.OPEN_FILE, { windowId, leafId })
    this.broadcastEvent(DP_EVENTS.ACTIVE_FILE, { windowId, leafId })
  }

  public async saveFile (filePath: string): Promise<boolean> {
    const doc = this.documents.find(doc => doc.filePath === filePath)

    if (doc === undefined) {
      this._app.log.error(`[Document Provider] Could not save file ${filePath}: Not found in loaded documents!`)
      return false
    }

    // If saveFile was called from a timeout, clearTimeout does nothing but the
    // timeout is reset to undefined. However, implementing this check here
    // ensures that we can programmatically call saveFile anywhere else and
    // still have everything work as intended.
    if (doc.saveTimeout !== undefined) {
      clearTimeout(doc.saveTimeout)
      doc.saveTimeout = undefined
    }

    // NOTE: Remember that we MUST under any circumstances adapt the document
    // descriptor BEFORE attempting to save. The reason is that if we don't do
    // that, we can run into the following race condition:
    // 1. User changes the document
    // 2. The save commences
    // 3. The user adds more changes
    // 4. The save finishes and undos the modifications
    const content = doc.document.toString()
    doc.lastSavedVersion = doc.currentVersion

    if (doc.descriptor.type === 'file') {
      // In case of an MD File increase the word or char count
      const ast = markdownToAST(content)
      const newWordCount = countWords(ast)
      const newCharCount = countChars(ast)

      this._app.stats.updateWordCount(newWordCount - doc.lastSavedWordCount)
      // TODO: Proper character counting

      doc.lastSavedWordCount = newWordCount
      doc.lastSavedCharCount = newCharCount
    }

    this._ignoreChanges.push(filePath)

    if (doc.descriptor.type === 'file') {
      await FSALFile.save(
        doc.descriptor,
        content,
        this._app.fsal.getMarkdownFileParser(),
        null
      )
      await this.synchronizeDatabases() // The file may have gotten a library
    } else {
      await FSALCodeFile.save(doc.descriptor, content, null)
    }

    this._app.log.info(`[DocumentManager] File ${filePath} saved.`)
    this.broadcastEvent(DP_EVENTS.CHANGE_FILE_STATUS, { filePath, status: 'modification' })
    this.broadcastEvent(DP_EVENTS.FILE_SAVED, { filePath })

    return true
  }
}
