// Copyright 2013 Yahoo Inc. All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
/**
 * @fileoverview Provides the prompt that shows on Yahoo mail pages.
 */

goog.provide('e2e.ext.ui.YPrompt');

goog.require('e2e.ext.actions.Executor');
goog.require('e2e.ext.constants');
goog.require('e2e.ext.constants.Actions');
goog.require('e2e.ext.constants.CssClass');
goog.require('e2e.ext.constants.ElementId');
goog.require('e2e.ext.ui.dialogs.Generic');
goog.require('e2e.ext.ui.dialogs.InputType');
goog.require('e2e.ext.ui.draftmanager');
goog.require('e2e.ext.ui.panels.Chip');
goog.require('e2e.ext.ui.panels.ChipHolder');
goog.require('e2e.ext.ui.preferences');
goog.require('e2e.ext.ui.templates.yprompt');
goog.require('e2e.ext.utils');
goog.require('e2e.ext.utils.Error');
goog.require('e2e.ext.utils.action');
goog.require('e2e.ext.utils.text');
goog.require('e2e.openpgp.asciiArmor');
goog.require('goog.Timer');
goog.require('goog.array');
goog.require('goog.dom');
goog.require('goog.dom.classlist');
goog.require('goog.events.EventType');
goog.require('goog.object');
goog.require('goog.string');
goog.require('goog.string.format');
goog.require('goog.ui.Component');
goog.require('soy');

goog.scope(function() {
var constants = e2e.ext.constants;
var dialogs = e2e.ext.ui.dialogs;
var drafts = e2e.ext.ui.draftmanager;
var ext = e2e.ext;
var messages = e2e.ext.messages;
var panels = e2e.ext.ui.panels;
var preferences = e2e.ext.ui.preferences;
var templates = e2e.ext.ui.templates.yprompt;
var ui = e2e.ext.ui;
var utils = e2e.ext.utils;



/**
 * Constructor for the prompt.
 * @constructor
 * @extends {goog.ui.Component}
 */
ui.YPrompt = function() {
  goog.base(this);

  /**
   * Executor for the End-to-End actions.
   * @type {!e2e.ext.actions.Executor}
   * @private
   */
  this.actionExecutor_ = new e2e.ext.actions.Executor(
      goog.bind(this.displayFailure_, this));

  /**
   * A timer to automatically save drafts.
   * TODO(user): Optimize the frequency of which auto-save triggers as it will
   * cause additional CPU (and possibly network) utilization.
   * @type {!goog.Timer}
   * @private
   */
  this.autoSaveTimer_ = new goog.Timer(constants.AUTOSAVE_INTERVAL);
  this.registerDisposable(this.autoSaveTimer_);
};
goog.inherits(ui.YPrompt, goog.ui.Component);

/**
 * Send a message to the Launcher background page so it an execute an action
 * on the PGP content.
 * @param {messages.launcherMessage} args Message to send to launcher
 * @param {function(messages.launcherMessage)=} callback function to call with
 *   the result of the action.
 * @private
 */
var sendLauncher_ = function(args, callback) {
  // This simply listens for a response.
  var respHandler = function(message) {
    if (!message.e2ebind) {
      return;
    }

    callback(message);
    chrome.runtime.onMessage.removeListener(respHandler);
  };

  // Send the message
  chrome.runtime.onMessage.addListener(respHandler);
  args.e2ebind = true;
  chrome.runtime.sendMessage(args);
};

/**
 * The extension's launcher. Needed for providing the passphrase to the user's
 * private key.
 * @type {ext.Launcher}
 * @private
 */
ui.YPrompt.prototype.pgpLauncher_ = null;

/**
 * A holder for the intended recipients of a PGP message.
 * @type {panels.ChipHolder}
 * @private
 */
ui.YPrompt.prototype.chipHolder_ = null;


/** @override */
ui.YPrompt.prototype.decorateInternal = function(elem) {
  goog.base(this, 'decorateInternal', elem);

  soy.renderElement(elem, templates.main, {
    extName: chrome.i18n.getMessage('extName')
  });

  var styles = elem.querySelector('link');
  styles.href = chrome.extension.getURL('yprompt_styles.css');

  utils.action.getExtensionLauncher(function(launcher) {
    this.pgpLauncher_ = launcher || this.pgpLauncher_;
  }, this.displayFailure_, this);
  utils.action.getSelectedContent(this.processSelectedContent_,
                                  this.displayFailure_, this);
};


/**
 * Process the retrieved content blob and display it into the yprompt UI.
 * @param {?messages.BridgeMessageRequest} contentBlob The content that the user
 *     has selected.
 * @param {constants.Actions=} opt_action Optional. The PGP action to perform.
 *     Defaults to user-specified.
 * @private
 */
ui.YPrompt.prototype.processSelectedContent_ =
    function(contentBlob, opt_action) {
  this.clearFailure_();
  this.autoSaveTimer_.stop();
  var action = opt_action || ext.constants.Actions.USER_SPECIFIED;
  var content = '';
  var origin = '';
  var recipients = [];
  var canInject = false;
  var subject = '';
  var from = null;

  // Obsolete in Yahoo E2E UI
  contentBlob = null;

  if (contentBlob) {
    if (contentBlob.request) {
      content = contentBlob.selection;
    }
    action = opt_action || contentBlob.action ||
        utils.text.getPgpAction(content, preferences.isActionSniffingEnabled());
    origin = contentBlob.origin;
    if (e2e.openpgp.asciiArmor.isDraft(content)) {
      action = constants.Actions.ENCRYPT_SIGN;
    }
    recipients = contentBlob.recipients || [];
    contentBlob.action = action;
    canInject = contentBlob.canInject;
    if (contentBlob.subject) {
      subject = contentBlob.subject;
    }
    if (contentBlob.from) {
      from = contentBlob.from;
    }
  }

  if (!this.pgpLauncher_.hasPassphrase() &&
      action != ext.constants.Actions.GET_PASSPHRASE) {
    this.processSelectedContent_(
        contentBlob, ext.constants.Actions.GET_PASSPHRASE);
    return;
  }

  this.getHandler().listen(
      this.autoSaveTimer_,
      goog.Timer.TICK,
      goog.partial(this.saveDraft_, origin));

  var elem = goog.dom.getElement(constants.ElementId.BODY);
  var title = goog.dom.getElement(constants.ElementId.TITLE);
  title.textContent = this.getTitle_(action) || title.textContent;
  switch (action) {
    case constants.Actions.ENCRYPT_SIGN:
      this.renderEncrypt_(elem, recipients, canInject, origin, subject, from);

      var sniffedAction = utils.text.getPgpAction(
          content, preferences.isActionSniffingEnabled());
      if (sniffedAction == constants.Actions.DECRYPT_VERIFY) {
        this.actionExecutor_.execute(/** @type {!messages.ApiRequest} */ ({
          action: constants.Actions.DECRYPT_VERIFY,
          content: content,
          passphraseCallback: goog.bind(this.renderPassphraseCallback_, this)
        }), this, goog.bind(function(decrypted) {
          var textArea = /** @type {HTMLTextAreaElement} */
              (elem.querySelector('textarea'));
          if (e2e.openpgp.asciiArmor.isDraft(content)) {
            textArea.value = decrypted;
          } else {
            this.renderReply_(textArea, decrypted);
          }
        }, this));
      }

      break;
    case constants.Actions.DECRYPT_VERIFY:
      this.renderGenericForm_(
          elem,
          chrome.i18n.getMessage('promptDecryptVerifyActionLabel'),
          chrome.i18n.getMessage('promptDecryptVerifyPlaceholder'));
      break;
    case constants.Actions.IMPORT_KEY:
      this.renderGenericForm_(
          elem, chrome.i18n.getMessage('promptImportKeyActionLabel'));
      break;
    case constants.Actions.GET_PASSPHRASE:
      this.renderKeyringPassphrase_(elem, contentBlob);
      break;
    case constants.Actions.LOCK_KEYRING:
      this.close();
      this.pgpLauncher_.stop();
      break;
    case constants.Actions.USER_SPECIFIED:
      this.renderMenu_(elem, contentBlob);
      return;
    case constants.Actions.CONFIGURE_EXTENSION:
      chrome.tabs.create(
          {
            url: 'settings.html',
            active: false
          },
          goog.nullFunction);
      return;
    case constants.Actions.NO_OP:
      this.close();
      return;
  }

  var formText = elem.querySelector('textarea');
  if (formText) {
    formText.textContent = content;
  }

  this.getHandler().listen(
      elem, goog.events.EventType.CLICK,
      goog.bind(this.buttonClick_, this, action, origin, contentBlob));
};


/**
 * @param {constants.Actions} action
 * @param {string} origin
 * @param {messages.BridgeMessageRequest} contentBlob
 * @param {Event} event
 * @private
 */
ui.YPrompt.prototype.buttonClick_ = function(
    action, origin, contentBlob, event) {
  var elem = goog.dom.getElement(constants.ElementId.BODY);
  var target = event.target;

  if (target instanceof HTMLImageElement) {
    target = target.parentElement;
  }

  if (target instanceof Element) {
    if (goog.dom.classlist.contains(target, constants.CssClass.CANCEL)) {
      this.close();
    } else if (
      goog.dom.classlist.contains(target, constants.CssClass.ACTION)) {
      this.executeAction_(action, elem, origin);
    } else if (
      goog.dom.classlist.contains(target, constants.CssClass.BACK)) {
      this.processSelectedContent_(
          contentBlob, ext.constants.Actions.USER_SPECIFIED);
    }
  }
};


/**
 * Renders the main menu.
 * @param {Element} elem The element into which the UI elements are to be
 *     rendered.
 * @param {?messages.BridgeMessageRequest} contentBlob The content that the user
 *     has selected.
 * @private
 */
ui.YPrompt.prototype.renderMenu_ = function(elem, contentBlob) {
  soy.renderElement(elem, templates.renderMenu, {
    possibleActions: [
      {
        value: constants.Actions.IMPORT_KEY,
        title: chrome.i18n.getMessage('promptImportKeyTitle')
      },
      {
        value: constants.Actions.CONFIGURE_EXTENSION,
        title: chrome.i18n.getMessage('actionConfigureExtension')
      },
      {
        value: constants.Actions.LOCK_KEYRING,
        title: chrome.i18n.getMessage('actionLockKeyring')
      }
    ]
  });

  this.getHandler().listen(
      elem.querySelector('ul'),
      goog.events.EventType.CLICK,
      goog.partial(this.selectAction_, contentBlob),
      true);
};


/**
 * Extracts user addresses from user IDs and creates an email to user IDs map.
 * Ignores user IDs without a valid e-mail address.
 * @param  {!Array.<string>} recipients user IDs of recipients
 * @return {!Object.<string, !Array.<string>>} email to user IDs map
 * @private
 */
ui.YPrompt.prototype.getRecipientsEmailMap_ = function(recipients) {
    var map = {};
    goog.array.forEach(recipients, function(recipient) {
        var email = utils.text.extractValidEmail(recipient);
        if (email) {
          if (!map.hasOwnProperty(email)) {
            map[email] = [];
          }
          map[email].push(recipient);
        }
    });
    return map;
};


/**
 * Renders the UI elements needed for PGP encryption.
 * @param {Element} elem The element into which the UI elements are to be
 *     rendered.
 * @param {!Array.<string>} recipients The initial list of identified
 *     recipients for the encrypted message.
 * @param {boolean} canInject True if the encrypted message can be injected
 *     into the active tab.
 * @param {string} origin The web origin where the message was created.
 * @param {string} subject The subject of the message
 * @param {string} from Address that the message is from
 * @private
 */
ui.YPrompt.prototype.renderEncrypt_ =
    function(elem, recipients, canInject, origin, subject, from) {
  var intendedRecipients = [];

  // Pre-populate the list of recipients during an encrypt/sign action.
  this.actionExecutor_.execute(/** @type {!messages.ApiRequest} */ ({
    action: constants.Actions.LIST_KEYS,
    content: 'public'
  }), this, goog.bind(function(searchResult) {
    var allAvailableRecipients = goog.object.getKeys(searchResult);
    var recipientsEmailMap = this.getRecipientsEmailMap_(
        allAvailableRecipients);
    goog.array.forEach(recipients, function(recipient) {
      if (recipientsEmailMap.hasOwnProperty(recipient)) {
        goog.array.extend(intendedRecipients,
            recipientsEmailMap[recipient]);
      }
    });

    this.actionExecutor_.execute(/** @type {!messages.ApiRequest} */ ({
      action: constants.Actions.LIST_KEYS,
      content: 'private'
    }), this, goog.bind(function(privateKeyResult) {
      var availableSigningKeys = goog.object.getKeys(privateKeyResult);
      var signInsertLabel = from ?
          chrome.i18n.getMessage('promptEncryptSignInsertIntoSupportedLabel') :
          chrome.i18n.getMessage('promptEncryptSignInsertLabel');

      soy.renderElement(elem, templates.renderEncrypt, {
        insertCheckboxEnabled: canInject,
        signerCheckboxTitle: chrome.i18n.getMessage('promptSignMessageAs'),
        fromLabel: chrome.i18n.getMessage('promptFromLabel'),
        noPrivateKeysFound: chrome.i18n.getMessage('promptNoPrivateKeysFound'),
        availableSigningKeys: availableSigningKeys,
        passphraseEncryptionLinkTitle: chrome.i18n.getMessage(
            'promptEncryptionPassphraseLink'),
        actionButtonTitle: chrome.i18n.getMessage(
            'promptEncryptSignActionLabel'),
        cancelButtonTitle: chrome.i18n.getMessage('actionCancelPgpAction'),
        optionsButtonTitle: chrome.i18n.getMessage('actionConfigureExtension'),
        backButtonTitle: chrome.i18n.getMessage('actionBackToMenu'),
        saveDraftButtonTitle: chrome.i18n.getMessage(
            'promptEncryptSignSaveDraftLabel'),
        insertButtonTitle: signInsertLabel,
        subject: subject
      });

      var textArea = elem.querySelector('textarea');
      if (drafts.hasDraft(origin)) {
        var popupElem =
            goog.dom.getElement(constants.ElementId.CALLBACK_DIALOG);
        var dialog = new dialogs.Generic(
            chrome.i18n.getMessage('promptEncryptSignRestoreDraftMsg'),
            goog.bind(function(dialogResult) {
              if (goog.isDef(dialogResult)) {
                // A passed object signals that the user has clicked the
                // 'OK' button.
                var draft = drafts.getDraft(origin);
                this.actionExecutor_.execute(
                    /** @type {!messages.ApiRequest} */ ({
                      action: constants.Actions.DECRYPT_VERIFY,
                      content: draft,
                      passphraseCallback: goog.bind(
                          this.renderPassphraseCallback_, this)
                    }), this, goog.bind(function(decrypted) {
                      textArea.value = decrypted;
                      this.surfaceDismissButton_();
                    }, this));
              } else {
                drafts.clearDraft(origin);
              }

              goog.dispose(dialog);
            }, this),
            dialogs.InputType.NONE,
            '',
            chrome.i18n.getMessage('promptEncryptSignRestoreDraftLabel'),
            chrome.i18n.getMessage('promptEncryptSignDiscardDraftLabel'));
        this.addChild(dialog, false);
        dialog.render(popupElem);
      }

      this.getHandler().listen(
          goog.dom.getElement(constants.ElementId.PASSPHRASE_ENCRYPTION_LINK),
          goog.events.EventType.CLICK, this.renderEncryptionPassphraseDialog_);

      this.getHandler().listen(
          this.getElementByClass(constants.CssClass.OPTIONS),
          goog.events.EventType.CLICK,
          goog.partial(this.processSelectedContent_,
              null, constants.Actions.CONFIGURE_EXTENSION));

      if (canInject) {
        this.getHandler().listen(
            this.getElementByClass(constants.CssClass.SAVE),
            goog.events.EventType.CLICK, goog.partial(this.saveDraft_, origin));

        this.getHandler().listen(
            this.getElementByClass(constants.CssClass.INSERT),
            goog.events.EventType.CLICK,
            goog.partial(this.insertMessageIntoPage_, origin));
      }

      this.chipHolder_ = new panels.ChipHolder(
          intendedRecipients, allAvailableRecipients);
      this.addChild(this.chipHolder_, false);
      this.chipHolder_.decorate(
          goog.dom.getElement(constants.ElementId.CHIP_HOLDER));

      if (preferences.isAutoSaveEnabled()) {
        this.getHandler().listenOnce(textArea, goog.events.EventType.KEYDOWN,
            goog.bind(this.autoSaveTimer_.start, this.autoSaveTimer_));
      }
    }, this));
  }, this));
};


/**
 * Renders the UI elements needed for a PGP key import.
 * @param {Element} elem The element into which the UI elements are to be
 *     rendered.
 * @param {string} actionButtonTitle The title for the form's action button.
 * @param {string=} opt_textAreaPlaceholder The placeholder text that will be
 *     displayed in the form's textarea.
 * @private
 */
ui.YPrompt.prototype.renderGenericForm_ =
    function(elem, actionButtonTitle, opt_textAreaPlaceholder) {
  soy.renderElement(elem, templates.renderGenericForm, {
    textAreaPlaceholder: opt_textAreaPlaceholder || '',
    actionButtonTitle: actionButtonTitle,
    cancelButtonTitle: chrome.i18n.getMessage('actionCancelPgpAction'),
    backButtonTitle: chrome.i18n.getMessage('actionBackToMenu')
  });
};


/**
 * Renders the UI elements needed for requesting the passphrase of the PGP
 * keyring.
 * @param {Element} elem The element into which the UI elements are to be
 *     rendered.
 * @param {?messages.BridgeMessageRequest} contentBlob The content that the user
 *     has selected.
 * @param {boolean=} showError Whether to show an error because previous passphrase
 *     attempt had failed
 * @private
 */
ui.YPrompt.prototype.renderKeyringPassphrase_ = function(elem, contentBlob, showError) {
  var dialog = new dialogs.Generic(
      showError ? chrome.i18n.getMessage('passphraseIncorrectWarning') : '',
      goog.bind(function(passphrase) {
        try {
          // Correct passphrase entered.
          this.pgpLauncher_.start(passphrase);
          if (contentBlob && contentBlob.action) {
            if (contentBlob.action == constants.Actions.GET_PASSPHRASE) {
              contentBlob.action = undefined; // Fall into the default action.
            }
            this.processSelectedContent_(contentBlob, contentBlob.action);
          } else {
            this.close();
          }
        } catch (e) { // Incorrect passphrase, so ask again.
          this.renderKeyringPassphrase_(elem, contentBlob, true);
        }
        goog.dispose(dialog);
      }, this),
      // Use a password field to ask for the passphrase.
      dialogs.InputType.SECURE_TEXT,
      chrome.i18n.getMessage('actionEnterPassphraseDescription'),
      chrome.i18n.getMessage('actionEnterPassphrase'),
      chrome.i18n.getMessage('actionCancelPgpAction'));

  elem.textContent = '';
  this.addChild(dialog, false);
  dialog.render(elem);
  goog.dom.classlist.remove(elem, constants.CssClass.TRANSPARENT);
};


/**
 * Renders the UI elements needed for requesting the passphrase of an individual
 * PGP key.
 * @param {string} uid The UID of the PGP key.
 * @param {!function(string)} callback The callback to invoke when the
 *     passphrase has been provided.
 * @private
 */
ui.YPrompt.prototype.renderPassphraseCallback_ = function(uid, callback) {
  var popupElem = goog.dom.getElement(constants.ElementId.CALLBACK_DIALOG);
  var dialog = new dialogs.Generic(chrome.i18n.getMessage(
          'promptPassphraseCallbackMessage', uid),
      function(passphrase) {
        goog.dispose(dialog);
        callback(/** @type {string} */ (passphrase));
      },
      dialogs.InputType.SECURE_TEXT,
      '',
      chrome.i18n.getMessage('actionEnterPassphrase'),
      chrome.i18n.getMessage('actionCancelPgpAction'));

  this.addChild(dialog, false);
  dialog.render(popupElem);
};


/**
 * Renders the UI elements needed for requesting a passphrase for symmetrically
 * encrypting the current message.
 * @private
 */
ui.YPrompt.prototype.renderEncryptionPassphraseDialog_ = function() {
  var popupElem = goog.dom.getElement(constants.ElementId.CALLBACK_DIALOG);
  var passphraseDialog = new dialogs.Generic(
      chrome.i18n.getMessage('promptEncryptionPassphraseMessage'),
      goog.bind(function(passphrase) {
        goog.dispose(passphraseDialog);
        if (passphrase.length > 0) {
          this.renderEncryptionPassphraseConfirmDialog_(passphrase);
        }
      }, this),
      dialogs.InputType.SECURE_TEXT,
      '',
      chrome.i18n.getMessage('actionEnterPassphrase'),
      chrome.i18n.getMessage('actionCancelPgpAction'));

  this.addChild(passphraseDialog, false);
  passphraseDialog.render(popupElem);
};


/**
 * Renders the UI elements needed for requesting a passphrase for symmetrically
 * encrypting the current message.
 * @param {string} passphrase The original passphrase
 * @private
 */
ui.YPrompt.prototype.renderEncryptionPassphraseConfirmDialog_ =
    function(passphrase) {
  var popupElem = goog.dom.getElement(constants.ElementId.CALLBACK_DIALOG);
  var confirmDialog = new dialogs.Generic(
      chrome.i18n.getMessage('promptEncryptionPassphraseConfirmMessage'),
      goog.bind(function(confirmedPassphrase) {
        goog.dispose(confirmDialog);
        if (passphrase == confirmedPassphrase) {
          var chip = new panels.Chip(passphrase, true);
          this.chipHolder_.addChip(chip);
        } else {
          var errorDialog = new dialogs.Generic(
              chrome.i18n.getMessage('keyMgmtPassphraseMismatchLabel'),
              function() {
                goog.dispose(errorDialog);
              },
              dialogs.InputType.NONE);
          this.addChild(errorDialog, false);
          errorDialog.render(popupElem);
        }
      }, this),
      dialogs.InputType.SECURE_TEXT,
      '',
      chrome.i18n.getMessage('actionEnterPassphrase'),
      chrome.i18n.getMessage('actionCancelPgpAction'));
  this.addChild(confirmDialog, false);
  confirmDialog.render(popupElem);
};



/**
 * Renders the original message to which the user wants to reply.
 * @param {HTMLTextAreaElement} textArea The text area where the reply body will
 *     be displayed.
 * @param {string} originalMsg The original message.
 * @private
 */
ui.YPrompt.prototype.renderReply_ = function(textArea, originalMsg) {
  var replyLineToken = '\n> ';
  var replyBody = utils.text.prettyTextWrap(
      originalMsg, (78 - replyLineToken.length));
  textArea.value = goog.string.format(
      '\n\n%s:\n%s',
      chrome.i18n.getMessage('promptEncryptSignReplyHeader'),
      replyLineToken + replyBody.split('\n').join(replyLineToken));
  textArea.setSelectionRange(0, 0);
};


/**
 * Closes the yprompt.
 */
ui.YPrompt.prototype.close = function() {
  goog.dispose(this);

  // Clear all input and text area fields to ensure that no data accidentally
  // leaks to the user.
  goog.array.forEach(
      document.querySelectorAll('textarea,input'), function(elem) {
        elem.value = '';
      });

  window.close();
};


/**
 * Returns the i18n title for the given PGP action.
 * @param {constants.Actions} action The PGP action that the user has
 *     requested.
 * @return {string} The i18n title.
 * @private
 */
ui.YPrompt.prototype.getTitle_ = function(action) {
  switch (action) {
    case ext.constants.Actions.ENCRYPT_SIGN:
      return chrome.i18n.getMessage('promptEncryptSignTitle');
    case ext.constants.Actions.DECRYPT_VERIFY:
      return chrome.i18n.getMessage('promptDecryptVerifyTitle');
    case ext.constants.Actions.IMPORT_KEY:
      return chrome.i18n.getMessage('promptImportKeyTitle');
    case ext.constants.Actions.USER_SPECIFIED:
      return chrome.i18n.getMessage('actionUserSpecified');
    case ext.constants.Actions.GET_PASSPHRASE:
      return chrome.i18n.getMessage('actionUnlockKeyring');
  }

  return '';
};


/**
 * Enables the user to select the PGP action they'd like to execute.
 * @param {?messages.BridgeMessageRequest} contentBlob The content that the user
 *     has selected.
 * @param {!goog.events.Event} clickEvt The event generated by the user's
 *     selection.
 * @private
 */
ui.YPrompt.prototype.selectAction_ = function(contentBlob, clickEvt) {
  var selection = /** @type {HTMLElement} */ (clickEvt.target);
  this.processSelectedContent_(
      contentBlob,
      /** @type {constants.Actions} */ (selection.getAttribute('action')));
};


/**
 * Executes the PGP action and displays the result to the user.
 * @param {constants.Actions} action The PGP action that the user has
 *     requested.
 * @param {Element} elem The element with the textarea where the result of the
 *     action will be displayed.
 * @param {string} origin The web origin for which the PGP action is performed.
 * @private
 */
ui.YPrompt.prototype.executeAction_ = function(action, elem, origin) {
  var textArea = elem.querySelector('textarea');
  this.clearFailure_();
  switch (action) {
    case ext.constants.Actions.ENCRYPT_SIGN:
      var request = /** @type {!messages.ApiRequest} */ ({
        action: constants.Actions.ENCRYPT_SIGN,
        content: textArea.value,
        currentUser:
            goog.dom.getElement(constants.ElementId.SIGNER_SELECT).value
      });

      if (this.chipHolder_) {
        request.recipients = this.chipHolder_.getSelectedUids();
        request.encryptPassphrases = this.chipHolder_.getProvidedPassphrases();
      }

      var signerCheck =
          goog.dom.getElement(constants.ElementId.SIGN_MESSAGE_CHECK);
      request.signMessage = signerCheck && signerCheck.checked;

      this.actionExecutor_.execute(
          request, this, goog.bind(function(encrypted) {
            textArea.disabled = true;
            textArea.value = encrypted;
            this.chipHolder_.lock();
            var passphraseEncryptionLink = goog.dom.getElement(
                constants.ElementId.PASSPHRASE_ENCRYPTION_LINK);
            goog.dom.classlist.add(passphraseEncryptionLink,
                constants.CssClass.INVISIBLE);
            var signCheckbox = goog.dom.getElement(
              constants.ElementId.SIGN_MESSAGE_CHECK);
            signCheckbox.disabled = true;
            this.clearSavedDraft_(origin);
            this.surfaceDismissButton_();
            var insertButton =
                this.getElementByClass(constants.CssClass.INSERT);
            if (insertButton) {
              goog.dom.classlist.remove(
                  insertButton, constants.CssClass.HIDDEN);
            }
          }, this));
      break;
    case constants.Actions.DECRYPT_VERIFY:
      this.actionExecutor_.execute(/** @type {!messages.ApiRequest} */ ({
        action: constants.Actions.DECRYPT_VERIFY,
        content: textArea.value,
        passphraseCallback: goog.bind(this.renderPassphraseCallback_, this)
      }), this, goog.bind(function(decrypted) {
        textArea.value = decrypted;
        var successMessage = chrome.i18n.getMessage('promptDecryptionSuccessMsg');
        this.displaySuccess_(successMessage, goog.nullFunction);
        this.surfaceDismissButton_();
      }, this));
      break;
    case ext.constants.Actions.IMPORT_KEY:
      this.actionExecutor_.execute(/** @type {!messages.ApiRequest} */ ({
        action: constants.Actions.IMPORT_KEY,
        content: textArea.value,
        passphraseCallback: goog.bind(this.renderPassphraseCallback_, this)
      }), this, goog.bind(function(res) {
        if (res.length > 0) {
          // Key import successful for at least one UID.
          utils.showNotification(
              chrome.i18n.getMessage(
                  'promptImportKeyNotificationLabel', res.toString()),
              goog.bind(this.close, this));
        } else {
          this.displayFailure_(new utils.Error(
              'Import key error', 'promptImportKeyError'));
        }
        this.surfaceDismissButton_();
      }, this));
      break;
  }
};


/**
 * Displays an error message to the user.
 * @param {Error} error The error to display.
 * @private
 */
ui.YPrompt.prototype.displayFailure_ = function(error) {
  var errorDiv = goog.dom.getElement(constants.ElementId.ERROR_DIV);
  var errorMsg = goog.isDef(error.messageId) ?
      chrome.i18n.getMessage(error.messageId) : error.message;
  utils.errorHandler(error);
  errorDiv.textContent = errorMsg;
};


/**
 * Clears the error message notfication area.
 * @private
 */
ui.YPrompt.prototype.clearFailure_ = function() {
  var errorDiv = goog.dom.getElement(constants.ElementId.ERROR_DIV);
  errorDiv.textContent = '';
};

/**
 * Notifies user of successful operation.
 * @param {string} msg The message to display
 * @param {!function(...)} callback function to invoke when notification has
 *   been displayed
 * @private
 */
ui.YPrompt.prototype.displaySuccess_ = function(msg, callback) {
  sendLauncher_({action: 'show_notification', msg: msg}, callback);
};

/**
 * Surfaces the Dismiss button in the UI.
 * @private
 */
ui.YPrompt.prototype.surfaceDismissButton_ = function() {
  goog.array.forEach(
      this.getElement().querySelectorAll('button.action,button.save'),
      function(button) {
        goog.dom.classlist.add(button, constants.CssClass.HIDDEN);
      });

  var cancelButton = this.getElementByClass(constants.CssClass.CANCEL);
  if (cancelButton) {
    cancelButton.textContent =
        chrome.i18n.getMessage('promptDismissActionLabel');
  }
};

/**
 * Inserts the encrypted content into the page.
 * @param {string} origin The web origin for which the PGP action is performed.
 * @private
 */
ui.YPrompt.prototype.insertMessageIntoPage_ = function(origin) {
  var textArea = this.getElement().querySelector('textarea');
  var recipients = this.chipHolder_.getSelectedUids();
  var subject = this.getElement().querySelector('#subjectHolder input').value;
  utils.action.updateSelectedContent(
      textArea.value, recipients, origin, false,
      this.close, this.displayFailure_, this, subject);
};


/**
 * Encrypts the current draft and persists it into the web app that the user is
 * interacting with.
 * @param {string} origin The web origin where the message was created.
 * @param {goog.events.Event} evt The event that triggers the saving of the
 *     draft.
 * @private
 */
ui.YPrompt.prototype.saveDraft_ = function(origin, evt) {
  var formText = this.getElement().querySelector('textarea');

  this.actionExecutor_.execute(/** @type {!messages.ApiRequest} */ ({
    action: constants.Actions.ENCRYPT_SIGN,
    content: formText.value,
    currentUser: goog.dom.getElement(constants.ElementId.SIGNER_SELECT).value
  }), this, goog.bind(function(encrypted) {
    var draft = e2e.openpgp.asciiArmor.markAsDraft(encrypted);
    if (evt.type == goog.events.EventType.CLICK) {
      utils.action.updateSelectedContent(
          draft, [], origin, true,
          goog.nullFunction, this.displayFailure_, this);
    } else {
      drafts.saveDraft(draft, origin);
    }
  }, this), goog.bind(function(error) {
    if (evt.type == goog.events.EventType.CLICK &&
        error.messageId == 'promptNoEncryptionTarget') {
      var popupElem = goog.dom.getElement(constants.ElementId.CALLBACK_DIALOG);
      var dialog = new dialogs.Generic(
          chrome.i18n.getMessage('promptNoEncryptionKeysFound'),
          function() {
            goog.dispose(dialog);
          },
          dialogs.InputType.NONE);

      this.addChild(dialog, false);
      dialog.render(popupElem);
    } else {
      this.displayFailure_(error);
    }
  }, this));
};


/**
 * Clears the saved draft and disables auto-save.
 * @param {string} origin The origin for which the drafts are to be removed.
 * @private
 */
ui.YPrompt.prototype.clearSavedDraft_ = function(origin) {
  this.autoSaveTimer_.stop();
  drafts.clearDraft(origin);
};

}); // goog.scope

// Create the settings page.
if (Boolean(chrome.extension)) {
  /** @type {!e2e.ext.ui.Prompt} */
  window.promptPage = new e2e.ext.ui.YPrompt();
  window.promptPage.decorate(document.documentElement);
}
