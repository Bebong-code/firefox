/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

ChromeUtils.defineESModuleGetters(this, {
  AppMenuNotifications: "resource://gre/modules/AppMenuNotifications.sys.mjs",
  ASRouter: "resource:///modules/asrouter/ASRouter.sys.mjs",
  MenuMessage: "resource:///modules/asrouter/MenuMessage.sys.mjs",
  NewTabUtils: "resource://gre/modules/NewTabUtils.sys.mjs",
  PanelMultiView: "resource:///modules/PanelMultiView.sys.mjs",
  updateZoomUI: "resource:///modules/ZoomUI.sys.mjs",
});

/**
 * Maintains the state and dispatches events for the main menu panel.
 */

const PanelUI = {
  /** Panel events that we listen for. **/
  get kEvents() {
    return ["popupshowing", "popupshown", "popuphiding", "popuphidden"];
  },

  /// Notification events used for overwriting notification actions
  get kNotificationEvents() {
    return ["buttoncommand", "secondarybuttoncommand", "learnmoreclick"];
  },

  /**
   * Used for lazily getting and memoizing elements from the document. Lazy
   * getters are set in init, and memoizing happens after the first retrieval.
   */
  get kElements() {
    return {
      multiView: "appMenu-multiView",
      menuButton: "PanelUI-menu-button",
      panel: "appMenu-popup",
      overflowFixedList: "widget-overflow-fixed-list",
      overflowPanel: "widget-overflow",
      navbar: "nav-bar",
    };
  },

  _initialized: false,
  _notifications: null,
  _notificationPanel: null,

  init(shouldSuppress) {
    this._shouldSuppress = shouldSuppress;
    this._initElements();

    this.menuButton.addEventListener("mousedown", this);
    this.menuButton.addEventListener("keypress", this);

    Services.obs.addObserver(this, "fullscreen-nav-toolbox");
    Services.obs.addObserver(this, "appMenu-notifications");
    Services.obs.addObserver(this, "show-update-progress");

    XPCOMUtils.defineLazyPreferenceGetter(
      this,
      "autoHideToolbarInFullScreen",
      "browser.fullscreen.autohide",
      false,
      (pref, previousValue, newValue) => {
        // On OSX, or with autohide preffed off, MozDOMFullscreen is the only
        // event we care about, since fullscreen should behave just like non
        // fullscreen. Otherwise, we don't want to listen to these because
        // we'd just be spamming ourselves with both of them whenever a user
        // opened a video.
        if (newValue) {
          window.removeEventListener("MozDOMFullscreen:Entered", this);
          window.removeEventListener("MozDOMFullscreen:Exited", this);
          window.addEventListener("fullscreen", this);
        } else {
          window.addEventListener("MozDOMFullscreen:Entered", this);
          window.addEventListener("MozDOMFullscreen:Exited", this);
          window.removeEventListener("fullscreen", this);
        }

        this.updateNotifications(false);
      },
      autoHidePref => autoHidePref && Services.appinfo.OS !== "Darwin"
    );

    if (this.autoHideToolbarInFullScreen) {
      window.addEventListener("fullscreen", this);
    } else {
      window.addEventListener("MozDOMFullscreen:Entered", this);
      window.addEventListener("MozDOMFullscreen:Exited", this);
    }

    window.addEventListener("activate", this);
    CustomizableUI.addListener(this);

    // We do this sync on init because in order to have the overflow button show up
    // we need to know whether anything is in the permanent panel area.
    this.overflowFixedList.hidden = false;
    // Also unhide the separator. We use CSS to hide/show it based on the panel's content.
    this.overflowFixedList.previousElementSibling.hidden = false;
    CustomizableUI.registerPanelNode(
      this.overflowFixedList,
      CustomizableUI.AREA_FIXED_OVERFLOW_PANEL
    );
    this.updateOverflowStatus();

    Services.obs.notifyObservers(
      null,
      "appMenu-notifications-request",
      "refresh"
    );

    this._initialized = true;
  },

  _initElements() {
    for (let [k, v] of Object.entries(this.kElements)) {
      // Need to do fresh let-bindings per iteration
      let getKey = k;
      let id = v;
      this.__defineGetter__(getKey, function () {
        delete this[getKey];
        return (this[getKey] = document.getElementById(id));
      });
    }
  },

  _eventListenersAdded: false,
  _ensureEventListenersAdded() {
    if (this._eventListenersAdded) {
      return;
    }
    this._addEventListeners();
  },

  _addEventListeners() {
    for (let event of this.kEvents) {
      this.panel.addEventListener(event, this);
    }

    let helpView = PanelMultiView.getViewNode(document, "PanelUI-helpView");
    helpView.addEventListener("ViewShowing", this._onHelpViewShow);
    helpView.addEventListener("command", this._onHelpCommand);
    this._onLibraryCommand = this._onLibraryCommand.bind(this);
    PanelMultiView.getViewNode(
      document,
      "appMenu-libraryView"
    ).addEventListener("command", this._onLibraryCommand);
    this.mainView.addEventListener("command", this);
    this.mainView.addEventListener("ViewShowing", this._onMainViewShow);
    this._eventListenersAdded = true;
  },

  _removeEventListeners() {
    for (let event of this.kEvents) {
      this.panel.removeEventListener(event, this);
    }
    let helpView = PanelMultiView.getViewNode(document, "PanelUI-helpView");
    helpView.removeEventListener("ViewShowing", this._onHelpViewShow);
    helpView.removeEventListener("command", this._onHelpCommand);
    PanelMultiView.getViewNode(
      document,
      "appMenu-libraryView"
    ).removeEventListener("command", this._onLibraryCommand);
    this.mainView.removeEventListener("command", this);
    this._eventListenersAdded = false;
  },

  uninit() {
    this._removeEventListeners();

    if (this._notificationPanel) {
      for (let event of this.kEvents) {
        this.notificationPanel.removeEventListener(event, this);
      }
      for (let event of this.kNotificationEvents) {
        this.notificationPanel.removeEventListener(event, this);
      }
    }

    Services.obs.removeObserver(this, "fullscreen-nav-toolbox");
    Services.obs.removeObserver(this, "appMenu-notifications");
    Services.obs.removeObserver(this, "show-update-progress");

    window.removeEventListener("MozDOMFullscreen:Entered", this);
    window.removeEventListener("MozDOMFullscreen:Exited", this);
    window.removeEventListener("fullscreen", this);
    window.removeEventListener("activate", this);
    this.menuButton.removeEventListener("mousedown", this);
    this.menuButton.removeEventListener("keypress", this);
    CustomizableUI.removeListener(this);
  },

  /**
   * Opens the menu panel if it's closed, or closes it if it's
   * open.
   *
   * @param aEvent the event that triggers the toggle.
   */
  toggle(aEvent) {
    // Don't show the panel if the window is in customization mode,
    // since this button doubles as an exit path for the user in this case.
    if (document.documentElement.hasAttribute("customizing")) {
      return;
    }
    this._ensureEventListenersAdded();
    if (this.panel.state == "open") {
      this.hide();
    } else if (this.panel.state == "closed") {
      this.show(aEvent);
    }
  },

  /**
   * Opens the menu panel. If the event target has a child with the
   * toolbarbutton-icon attribute, the panel will be anchored on that child.
   * Otherwise, the panel is anchored on the event target itself.
   *
   * @param aEvent the event (if any) that triggers showing the menu.
   */
  show(aEvent) {
    this._ensureShortcutsShown();
    (async () => {
      await this.ensureReady();

      if (
        this.panel.state == "open" ||
        document.documentElement.hasAttribute("customizing")
      ) {
        return;
      }

      if (ASRouter.initialized) {
        await ASRouter.sendTriggerMessage({
          browser: gBrowser.selectedBrowser,
          id: "menuOpened",
          context: { source: MenuMessage.SOURCES.APP_MENU },
        });
      }

      let domEvent = null;
      if (aEvent && aEvent.type != "command") {
        domEvent = aEvent;
      }

      let anchor = this._getPanelAnchor(this.menuButton);
      await PanelMultiView.openPopup(this.panel, anchor, {
        triggerEvent: domEvent,
      });
    })().catch(console.error);
  },

  /**
   * If the menu panel is being shown, hide it.
   */
  hide() {
    if (document.documentElement.hasAttribute("customizing")) {
      return;
    }

    PanelMultiView.hidePopup(this.panel);
  },

  observe(subject, topic, status) {
    switch (topic) {
      case "fullscreen-nav-toolbox":
        if (this._notifications) {
          this.updateNotifications(false);
        }
        break;
      case "appMenu-notifications":
        // Don't initialize twice.
        if (status == "init" && this._notifications) {
          break;
        }
        this._notifications = AppMenuNotifications.notifications;
        this.updateNotifications(true);
        break;
      case "show-update-progress":
        openAboutDialog();
        break;
    }
  },

  handleEvent(aEvent) {
    // Ignore context menus and menu button menus showing and hiding:
    if (aEvent.type.startsWith("popup") && aEvent.target != this.panel) {
      return;
    }
    switch (aEvent.type) {
      case "popupshowing":
        updateEditUIVisibility();
      // Fall through
      case "popupshown":
        if (aEvent.type == "popupshown") {
          CustomizableUI.addPanelCloseListeners(this.panel);
        }
      // Fall through
      case "popuphiding":
        if (aEvent.type == "popuphiding") {
          updateEditUIVisibility();
        }
      // Fall through
      case "popuphidden":
        this.updateNotifications();
        this._updatePanelButton(aEvent.target);
        if (aEvent.type == "popuphidden") {
          CustomizableUI.removePanelCloseListeners(this.panel);
          MenuMessage.hideAppMenuMessage(gBrowser.selectedBrowser);
        }
        break;
      case "mousedown":
        // On Mac, ctrl-click will send a context menu event from the widget, so
        // we don't want to bring up the panel when ctrl key is pressed.
        if (
          aEvent.button == 0 &&
          (AppConstants.platform != "macosx" || !aEvent.ctrlKey)
        ) {
          this.toggle(aEvent);
        }
        break;
      case "keypress":
        if (aEvent.key == " " || aEvent.key == "Enter") {
          this.toggle(aEvent);
          aEvent.stopPropagation();
        }
        break;
      case "MozDOMFullscreen:Entered":
      case "MozDOMFullscreen:Exited":
      case "fullscreen":
      case "activate":
        this.updateNotifications();
        break;
      case "command":
        this.onCommand(aEvent);
        break;
      case "buttoncommand":
        this._onNotificationButtonEvent(aEvent, "buttoncommand");
        break;
      case "secondarybuttoncommand":
        this._onNotificationButtonEvent(aEvent, "secondarybuttoncommand");
        break;
      case "learnmoreclick":
        // Don't fall back to PopupNotifications.
        aEvent.preventDefault();
        break;
    }
  },

  // Note that we listen for bubbling command events. In the case where the
  // button that the user clicks has a command attribute, those events are
  // redirected to the relevant command element, and we never see them in
  // here. Bear this in mind if you want to write code that applies to
  // all commands, for which this wouldn't work well.
  onCommand(aEvent) {
    let { target } = aEvent;
    switch (target.id) {
      case "appMenu-update-banner":
        this._onBannerItemSelected(aEvent);
        break;
      case "appMenu-fxa-label2":
        gSync.toggleAccountPanel(target, aEvent);
        break;
      case "appMenu-bookmarks-button":
        BookmarkingUI.showSubView(target);
        break;
      case "appMenu-history-button":
        this.showSubView("PanelUI-history", target);
        break;
      case "appMenu-passwords-button":
        LoginHelper.openPasswordManager(window, { entryPoint: "Mainmenu" });
        break;
      case "appMenu-fullscreen-button2":
        // Note that we're custom-handling the hiding of the panel to make
        // sure it disappears before entering fullscreen. Otherwise it can
        // end up moving around on the screen during the fullscreen transition.
        target.closest("panel").hidePopup();
        setTimeout(() => BrowserCommands.fullScreen(), 0);
        break;
      case "appMenu-settings-button":
        openPreferences();
        break;
      case "appMenu-more-button2":
        this.showMoreToolsPanel(target);
        break;
      case "appMenu-help-button2":
        this.showSubView("PanelUI-helpView", target);
        break;
    }
  },

  get isReady() {
    return !!this._isReady;
  },

  get isNotificationPanelOpen() {
    let panelState = this.notificationPanel.state;

    return panelState == "showing" || panelState == "open";
  },

  /**
   * Registering the menu panel is done lazily for performance reasons. This
   * method is exposed so that CustomizationMode can force panel-readyness in the
   * event that customization mode is started before the panel has been opened
   * by the user.
   *
   * @param aCustomizing (optional) set to true if this was called while entering
   *        customization mode. If that's the case, we trust that customization
   *        mode will handle calling beginBatchUpdate and endBatchUpdate.
   *
   * @return a Promise that resolves once the panel is ready to roll.
   */
  async ensureReady() {
    if (this._isReady) {
      return;
    }

    await window.delayedStartupPromise;
    this._ensureEventListenersAdded();
    this.panel.hidden = false;
    this._isReady = true;
  },

  /**
   * Switch the panel to the help view if it's not already
   * in that view.
   */
  showHelpView(aAnchor) {
    this._ensureEventListenersAdded();
    this.multiView.showSubView("PanelUI-helpView", aAnchor);
  },

  /**
   * Switch the panel to the "More Tools" view.
   *
   * @param moreTools The panel showing the "More Tools" view.
   */
  showMoreToolsPanel(moreTools) {
    this.showSubView("appmenu-moreTools", moreTools);

    // Notify DevTools the panel view is showing and need it to populate the
    // "Browser Tools" section of the panel. We notify the observer setup by
    // DevTools because we want to ensure the same menuitem list is shared
    // between both the AppMenu and toolbar button views.
    let view = document.getElementById("appmenu-developer-tools-view");
    Services.obs.notifyObservers(view, "web-developer-tools-view-showing");
  },

  /**
   * Shows a subview in the panel with a given ID.
   *
   * @param aViewId the ID of the subview to show.
   * @param aAnchor the element that spawned the subview.
   * @param aEvent the event triggering the view showing.
   */
  async showSubView(aViewId, aAnchor, aEvent) {
    if (aEvent) {
      // On Mac, ctrl-click will send a context menu event from the widget, so
      // we don't want to bring up the panel when ctrl key is pressed.
      if (
        aEvent.type == "mousedown" &&
        (aEvent.button != 0 ||
          (AppConstants.platform == "macosx" && aEvent.ctrlKey))
      ) {
        return;
      }
      if (
        aEvent.type == "keypress" &&
        aEvent.key != " " &&
        aEvent.key != "Enter"
      ) {
        return;
      }
    }

    this._ensureEventListenersAdded();

    let viewNode = PanelMultiView.getViewNode(document, aViewId);
    if (!viewNode) {
      console.error("Could not show panel subview with id: ", aViewId);
      return;
    }

    if (!aAnchor) {
      console.error(
        "Expected an anchor when opening subview with id: ",
        aViewId
      );
      return;
    }

    this._ensureShortcutsShown(viewNode);
    this.ensurePanicViewInitialized(viewNode);

    let container = aAnchor.closest("panelmultiview");
    if (container && !viewNode.hasAttribute("disallowSubView")) {
      container.showSubView(aViewId, aAnchor);
    } else if (!aAnchor.open) {
      aAnchor.open = true;

      let tempPanel = document.createXULElement("panel");
      tempPanel.setAttribute("type", "arrow");
      tempPanel.setAttribute("id", "customizationui-widget-panel");
      if (viewNode.hasAttribute("neverhidden")) {
        tempPanel.setAttribute("neverhidden", "true");
      }

      tempPanel.setAttribute("class", "cui-widget-panel panel-no-padding");
      tempPanel.setAttribute("viewId", aViewId);
      if (aAnchor.getAttribute("tabspecific")) {
        tempPanel.setAttribute("tabspecific", true);
      }
      if (aAnchor.getAttribute("locationspecific")) {
        tempPanel.setAttribute("locationspecific", true);
      }
      if (this._disableAnimations) {
        tempPanel.setAttribute("animate", "false");
      }
      tempPanel.setAttribute("context", "");
      document
        .getElementById(CustomizableUI.AREA_NAVBAR)
        .appendChild(tempPanel);

      let multiView = document.createXULElement("panelmultiview");
      multiView.setAttribute("id", "customizationui-widget-multiview");
      multiView.setAttribute("viewCacheId", "appMenu-viewCache");
      multiView.setAttribute("mainViewId", viewNode.id);
      multiView.appendChild(viewNode);
      tempPanel.appendChild(multiView);
      viewNode.classList.add("cui-widget-panelview", "PanelUI-subView");

      let viewShown = false;
      let panelRemover = event => {
        // Avoid bubbled events triggering the panel closing.
        if (event && event.target != tempPanel) {
          return;
        }
        viewNode.classList.remove("cui-widget-panelview");
        if (viewShown) {
          CustomizableUI.removePanelCloseListeners(tempPanel);
          tempPanel.removeEventListener("popuphidden", panelRemover);
        }
        aAnchor.open = false;

        PanelMultiView.removePopup(tempPanel);
      };

      if (aAnchor.parentNode.id == "PersonalToolbar") {
        tempPanel.classList.add("bookmarks-toolbar");
      }

      let anchor = this._getPanelAnchor(aAnchor);

      if (aAnchor != anchor && aAnchor.id) {
        anchor.setAttribute("consumeanchor", aAnchor.id);
      }

      try {
        viewShown = await PanelMultiView.openPopup(tempPanel, anchor, {
          position: "bottomright topright",
          triggerEvent: aEvent,
        });
      } catch (ex) {
        console.error(ex);
      }

      if (viewShown) {
        CustomizableUI.addPanelCloseListeners(tempPanel);
        tempPanel.addEventListener("popuphidden", panelRemover);
      } else {
        panelRemover();
      }
    }
  },

  /**
   * Adds FTL before appending the panic view markup to the main DOM.
   *
   * @param {panelview} panelView The Panic View panelview.
   */
  ensurePanicViewInitialized(panelView) {
    if (panelView.id != "PanelUI-panicView" || panelView._initialized) {
      return;
    }

    if (!this.panic) {
      this.panic = panelView;
    }

    MozXULElement.insertFTLIfNeeded("browser/panicButton.ftl");
    panelView._initialized = true;
  },

  /**
   * NB: The enable- and disableSingleSubviewPanelAnimations methods only
   * affect the hiding/showing animations of single-subview panels (tempPanel
   * in the showSubView method).
   */
  disableSingleSubviewPanelAnimations() {
    this._disableAnimations = true;
  },

  enableSingleSubviewPanelAnimations() {
    this._disableAnimations = false;
  },

  updateOverflowStatus() {
    let hasKids = this.overflowFixedList.hasChildNodes();
    if (hasKids && !this.navbar.hasAttribute("nonemptyoverflow")) {
      this.navbar.setAttribute("nonemptyoverflow", "true");
      this.overflowPanel.setAttribute("hasfixeditems", "true");
    } else if (!hasKids && this.navbar.hasAttribute("nonemptyoverflow")) {
      PanelMultiView.hidePopup(this.overflowPanel);
      this.overflowPanel.removeAttribute("hasfixeditems");
      this.navbar.removeAttribute("nonemptyoverflow");
    }
  },

  onWidgetAfterDOMChange(aNode, aNextNode, aContainer) {
    if (aContainer == this.overflowFixedList) {
      this.updateOverflowStatus();
    }
  },

  onAreaReset(aArea, aContainer) {
    if (aContainer == this.overflowFixedList) {
      this.updateOverflowStatus();
    }
  },

  /**
   * Sets the anchor node into the open or closed state, depending
   * on the state of the panel.
   */
  _updatePanelButton() {
    let { state } = this.panel;
    if (state == "open" || state == "showing") {
      this.menuButton.open = true;
      document.l10n.setAttributes(
        this.menuButton,
        "appmenu-menu-button-opened2"
      );
    } else {
      this.menuButton.open = false;
      document.l10n.setAttributes(
        this.menuButton,
        "appmenu-menu-button-closed2"
      );
    }
  },

  _onMainViewShow(event) {
    let panelview = event.target;
    let messageId = panelview.getAttribute(
      MenuMessage.SHOWING_FXA_MENU_MESSAGE_ATTR
    );
    if (messageId) {
      MenuMessage.recordMenuMessageTelemetry(
        "IMPRESSION",
        MenuMessage.SOURCES.APP_MENU,
        messageId
      );
      let message = ASRouter.getMessageById(messageId);
      ASRouter.addImpression(message);
    }
    updateZoomUI(gBrowser.selectedBrowser);
  },

  _onHelpViewShow() {
    // Call global menu setup function
    buildHelpMenu();

    let helpMenu = document.getElementById("menu_HelpPopup");
    let items = this.getElementsByTagName("vbox")[0];
    let attrs = ["command", "onclick", "key", "disabled", "accesskey", "label"];

    // Remove all buttons from the view
    while (items.firstChild) {
      items.firstChild.remove();
    }

    // Add the current set of menuitems of the Help menu to this view
    let menuItems = Array.prototype.slice.call(
      helpMenu.getElementsByTagName("menuitem")
    );
    let fragment = document.createDocumentFragment();
    for (let node of menuItems) {
      if (node.hidden) {
        continue;
      }
      let button = document.createXULElement("toolbarbutton");
      // Copy specific attributes from a menuitem of the Help menu
      for (let attrName of attrs) {
        if (!node.hasAttribute(attrName)) {
          continue;
        }
        button.setAttribute(attrName, node.getAttribute(attrName));
      }

      // We have AppMenu-specific strings for the Help menu. By convention,
      // their localization IDs are set on "appmenu-data-l10n-id" attributes.
      let l10nId = node.getAttribute("appmenu-data-l10n-id");
      if (l10nId) {
        document.l10n.setAttributes(button, l10nId);
      }

      if (node.id) {
        button.id = "appMenu_" + node.id;
      }

      button.classList.add("subviewbutton");
      fragment.appendChild(button);
    }

    // The Enterprise Support menu item has a different location than its
    // placement in the menubar, so we need to specify it here.
    let helpPolicySupport = fragment.querySelector(
      "#appMenu_helpPolicySupport"
    );
    if (helpPolicySupport) {
      fragment.insertBefore(
        helpPolicySupport,
        fragment.querySelector("#appMenu_menu_HelpPopup_reportPhishingtoolmenu")
          .nextSibling
      );
    }

    items.appendChild(fragment);
  },

  _onHelpCommand(aEvent) {
    switch (aEvent.target.id) {
      case "appMenu_menu_openHelp":
        openHelpLink("firefox-help");
        break;
      case "appMenu_menu_layout_debugger":
        toOpenWindowByType(
          "mozapp:layoutdebug",
          "chrome://layoutdebug/content/layoutdebug.xhtml"
        );
        break;
      case "appMenu_feedbackPage":
        openFeedbackPage();
        break;
      case "appMenu_helpSafeMode":
        safeModeRestart();
        break;
      case "appMenu_troubleShooting":
        openTroubleshootingPage();
        break;
      case "appMenu_menu_HelpPopup_reportPhishingtoolmenu":
        openUILink(gSafeBrowsing.getReportURL("Phish"), aEvent, {
          triggeringPrincipal:
            Services.scriptSecurityManager.createNullPrincipal({}),
        });
        break;
      case "appMenu_menu_HelpPopup_reportPhishingErrortoolmenu":
        gSafeBrowsing.reportFalseDeceptiveSite();
        break;
      case "appMenu_helpSwitchDevice":
        openSwitchingDevicesPage();
        break;
      case "appMenu_aboutName":
        openAboutDialog();
        break;
      case "appMenu_helpPolicySupport":
        openTrustedLinkIn(Services.policies.getSupportMenu().URL.href, "tab");
        break;
    }
  },

  _onLibraryCommand(aEvent) {
    let button = aEvent.target;
    let { BookmarkingUI, DownloadsPanel } = button.ownerGlobal;
    switch (button.id) {
      case "appMenu-library-bookmarks-button":
        BookmarkingUI.showSubView(button);
        break;
      case "appMenu-library-history-button":
        this.showSubView("PanelUI-history", button);
        break;
      case "appMenu-library-downloads-button":
        DownloadsPanel.showDownloadsHistory();
        break;
    }
  },

  _hidePopup() {
    if (!this._notificationPanel) {
      return;
    }

    if (this.isNotificationPanelOpen) {
      this.notificationPanel.hidePopup();
    }
  },

  /**
   * Selects and marks an item by id from the main view. The ids are an array,
   * the first in the main view and the later ids in subsequent subviews that
   * become marked when the user opens the subview. The subview marking is
   * cancelled if a different subview is opened.
   */
  async selectAndMarkItem(itemIds) {
    // This shouldn't really occur, but return early just in case.
    if (document.documentElement.hasAttribute("customizing")) {
      return;
    }

    // This function was triggered from a button while the menu was
    // already open, so the panel should be in the process of hiding.
    // Wait for the panel to hide first, then reopen it.
    if (this.panel.state == "hiding") {
      await new Promise(resolve => {
        this.panel.addEventListener("popuphidden", resolve, { once: true });
      });
    }

    if (this.panel.state != "open") {
      await new Promise(resolve => {
        this.panel.addEventListener("ViewShown", resolve, { once: true });
        this.show();
      });
    }

    let currentView;

    let viewShownCB = event => {
      viewHidingCB();

      if (itemIds.length) {
        let subItem = window.document.getElementById(itemIds[0]);
        if (event.target.id == subItem?.closest("panelview")?.id) {
          Services.tm.dispatchToMainThread(() => {
            markItem(event.target);
          });
        } else {
          itemIds = [];
        }
      }
    };

    let viewHidingCB = () => {
      if (currentView) {
        currentView.ignoreMouseMove = false;
      }
      currentView = null;
    };

    let popupHiddenCB = () => {
      viewHidingCB();
      this.panel.removeEventListener("ViewShown", viewShownCB);
    };

    let markItem = viewNode => {
      let id = itemIds.shift();
      let item = window.document.getElementById(id);
      item.setAttribute("tabindex", "-1");

      currentView = PanelView.forNode(viewNode);
      currentView.selectedElement = item;
      currentView.focusSelectedElement(true);

      // Prevent the mouse from changing the highlight temporarily.
      // This flag gets removed when the view is hidden or a key
      // is pressed.
      currentView.ignoreMouseMove = true;

      if (itemIds.length) {
        this.panel.addEventListener("ViewShown", viewShownCB, { once: true });
      }
      this.panel.addEventListener("ViewHiding", viewHidingCB, { once: true });
    };

    this.panel.addEventListener("popuphidden", popupHiddenCB, { once: true });
    markItem(this.mainView);
  },

  updateNotifications(notificationsChanged) {
    let notifications = this._notifications;
    if (!notifications || !notifications.length) {
      if (notificationsChanged) {
        this._clearAllNotifications();
        this._hidePopup();
      }
      return;
    }

    if (
      (window.fullScreen && FullScreen.navToolboxHidden) ||
      document.fullscreenElement ||
      this._shouldSuppress()
    ) {
      this._hidePopup();
      return;
    }

    let doorhangers = notifications.filter(
      n => !n.dismissed && !n.options.badgeOnly
    );

    if (this.panel.state == "showing" || this.panel.state == "open") {
      // If the menu is already showing, then we need to dismiss all
      // notifications since we don't want their doorhangers competing for
      // attention. Don't hide the badge though; it isn't really in competition
      // with anything.
      doorhangers.forEach(n => {
        n.dismissed = true;
        if (n.options.onDismissed) {
          n.options.onDismissed(window);
        }
      });
      this._hidePopup();
      if (!notifications[0].options.badgeOnly) {
        this._showBannerItem(notifications[0]);
      }
    } else if (doorhangers.length) {
      // Only show the doorhanger if the window is focused and not fullscreen
      if (
        (window.fullScreen && this.autoHideToolbarInFullScreen) ||
        Services.focus.activeWindow !== window
      ) {
        this._hidePopup();
        this._showBadge(doorhangers[0]);
        this._showBannerItem(doorhangers[0]);
      } else {
        this._clearBadge();
        this._showNotificationPanel(doorhangers[0]);
      }
    } else {
      this._hidePopup();
      this._showBadge(notifications[0]);
      this._showBannerItem(notifications[0]);
    }
  },

  _showNotificationPanel(notification) {
    this._refreshNotificationPanel(notification);

    if (this.isNotificationPanelOpen) {
      return;
    }

    if (notification.options.beforeShowDoorhanger) {
      notification.options.beforeShowDoorhanger(document);
    }

    let anchor = this._getPanelAnchor(this.menuButton);

    // Insert Fluent files when needed before notification is opened
    MozXULElement.insertFTLIfNeeded("branding/brand.ftl");
    MozXULElement.insertFTLIfNeeded("browser/appMenuNotifications.ftl");

    // After Fluent files are loaded into document replace data-lazy-l10n-ids with actual ones
    document
      .getElementById("appMenu-notification-popup")
      .querySelectorAll("[data-lazy-l10n-id]")
      .forEach(el => {
        el.setAttribute("data-l10n-id", el.getAttribute("data-lazy-l10n-id"));
        el.removeAttribute("data-lazy-l10n-id");
      });

    this.notificationPanel.openPopup(anchor, "bottomright topright");
  },

  _clearNotificationPanel() {
    for (let popupnotification of this.notificationPanel.children) {
      popupnotification.hidden = true;
      popupnotification.notification = null;
    }
  },

  _clearAllNotifications() {
    this._clearNotificationPanel();
    this._clearBadge();
    this._clearBannerItem();
  },

  get notificationPanel() {
    // Lazy load the panic-button-success-notification panel the first time we need to display it.
    if (!this._notificationPanel) {
      let template = document.getElementById("appMenuNotificationTemplate");
      template.replaceWith(template.content);
      this._notificationPanel = document.getElementById(
        "appMenu-notification-popup"
      );
      for (let event of this.kEvents) {
        this._notificationPanel.addEventListener(event, this);
      }
      for (let event of this.kNotificationEvents) {
        this._notificationPanel.addEventListener(event, this);
      }
    }
    return this._notificationPanel;
  },

  get mainView() {
    if (!this._mainView) {
      this._mainView = PanelMultiView.getViewNode(document, "appMenu-mainView");
    }
    return this._mainView;
  },

  get addonNotificationContainer() {
    if (!this._addonNotificationContainer) {
      this._addonNotificationContainer = PanelMultiView.getViewNode(
        document,
        "appMenu-addon-banners"
      );
    }

    return this._addonNotificationContainer;
  },

  _formatDescriptionMessage(n) {
    let text = {};
    let array = n.options.message.split("<>");
    text.start = array[0] || "";
    text.name = n.options.name || "";
    text.end = array[1] || "";
    return text;
  },

  _refreshNotificationPanel(notification) {
    this._clearNotificationPanel();

    let popupnotificationID = this._getPopupId(notification);
    let popupnotification = document.getElementById(popupnotificationID);

    popupnotification.setAttribute("id", popupnotificationID);

    if (notification.options.message) {
      let desc = this._formatDescriptionMessage(notification);
      popupnotification.setAttribute("label", desc.start);
      popupnotification.setAttribute("name", desc.name);
      popupnotification.setAttribute("endlabel", desc.end);
    }
    if (notification.options.onRefresh) {
      notification.options.onRefresh(window);
    }
    if (notification.options.popupIconURL) {
      popupnotification.setAttribute("icon", notification.options.popupIconURL);
      popupnotification.setAttribute("hasicon", true);
    }
    if (notification.options.learnMoreURL) {
      popupnotification.setAttribute(
        "learnmoreurl",
        notification.options.learnMoreURL
      );
    }

    popupnotification.notification = notification;
    popupnotification.show();
  },

  _showBadge(notification) {
    let badgeStatus = this._getBadgeStatus(notification);
    this.menuButton.setAttribute("badge-status", badgeStatus);
  },

  // "Banner item" here refers to an item in the hamburger panel menu. They will
  // typically show up as a colored row in the panel.
  _showBannerItem(notification) {
    const supportedIds = [
      "update-downloading",
      "update-available",
      "update-manual",
      "update-unsupported",
      "update-restart",
    ];
    if (!supportedIds.includes(notification.id)) {
      return;
    }

    if (!this._panelBannerItem) {
      this._panelBannerItem = this.mainView.querySelector(".panel-banner-item");
    }

    const messageIDs = {
      "update-downloading": "appmenuitem-banner-update-downloading",
      "update-available": "appmenuitem-banner-update-available",
      "update-manual": "appmenuitem-banner-update-manual",
      "update-unsupported": "appmenuitem-banner-update-unsupported",
      "update-restart": "appmenuitem-banner-update-restart",
    };

    document.l10n.setAttributes(
      this._panelBannerItem,
      messageIDs[notification.id]
    );

    this._panelBannerItem.setAttribute("notificationid", notification.id);
    this._panelBannerItem.hidden = false;
    this._panelBannerItem.notification = notification;
  },

  _clearBadge() {
    this.menuButton.removeAttribute("badge-status");
  },

  _clearBannerItem() {
    if (this._panelBannerItem) {
      this._panelBannerItem.notification = null;
      this._panelBannerItem.hidden = true;
    }
  },

  _onNotificationButtonEvent(event, type) {
    event.preventDefault();

    let notificationEl = getNotificationFromElement(event.originalTarget);

    if (!notificationEl) {
      throw new Error(
        "PanelUI._onNotificationButtonEvent: couldn't find notification element"
      );
    }

    if (!notificationEl.notification) {
      throw new Error(
        "PanelUI._onNotificationButtonEvent: couldn't find notification"
      );
    }

    let notification = notificationEl.notification;

    if (type == "secondarybuttoncommand") {
      AppMenuNotifications.callSecondaryAction(window, notification);
    } else {
      AppMenuNotifications.callMainAction(window, notification, true);
    }
  },

  _onBannerItemSelected(event) {
    let target = event.originalTarget;
    if (!target.notification) {
      throw new Error(
        "menucommand target has no associated action/notification"
      );
    }

    event.stopPropagation();
    AppMenuNotifications.callMainAction(window, target.notification, false);
  },

  _getPopupId(notification) {
    return "appMenu-" + notification.id + "-notification";
  },

  _getBadgeStatus(notification) {
    return notification.id;
  },

  _getPanelAnchor(candidate) {
    let iconAnchor = candidate.badgeStack || candidate.icon;
    return iconAnchor || candidate;
  },

  _ensureShortcutsShown(view = this.mainView) {
    if (view.hasAttribute("added-shortcuts")) {
      return;
    }
    view.setAttribute("added-shortcuts", "true");
    for (let button of view.querySelectorAll("toolbarbutton[key]")) {
      let keyId = button.getAttribute("key");
      let key = document.getElementById(keyId);
      if (!key) {
        continue;
      }
      button.setAttribute("shortcut", ShortcutUtils.prettifyShortcut(key));
    }
  },
};

XPCOMUtils.defineConstant(this, "PanelUI", PanelUI);

/**
 * Gets the currently selected locale for display.
 * @return  the selected locale
 */
function getLocale() {
  return Services.locale.appLocaleAsBCP47;
}

/**
 * Given a DOM node inside a <popupnotification>, return the parent <popupnotification>.
 */
function getNotificationFromElement(aElement) {
  return aElement.closest("popupnotification");
}
