/**
 * @license
 * Copyright 2013 Google Inc. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @fileoverview Provides common utility methods to the extension.
 */

goog.provide('e2e.ext.utils');
goog.provide('e2e.ext.utils.Error');

goog.require('e2e.ext.constants');
goog.require('e2e.ext.constants.ElementId');

goog.scope(function() {
var constants = e2e.ext.constants;
var messages = e2e.ext.messages;
var utils = e2e.ext.utils;


/**
 * Creates a blob URL to download a file.
 * @param {string} content The content to write to the new file.
 * @param {!function(string)} callback The callback to invoke with the URL of
 *     the created file.
 */
utils.writeToFile = function(content, callback) {
  var blob = new Blob(
      [content], {type: 'application/pgp-keys; format=text;'});
  var url = URL.createObjectURL(blob);
  callback(url);
};


/**
 * Reads the contents of the provided file returns it via the provided callback.
 * Automatically handles both binary OpenPGP packets and text files.
 * @param {(string|!File)} file The file to read.
 * @param {!function(string)} callback The callback to invoke with the file's
 *     contents.
 */
utils.readFile = function(file, callback) {
  utils.readFile_(false, file, function(contents) {
    // The 0x80 bit is always set for the Packet Tag for OpenPGP packets.
    if (contents.charCodeAt(0) >= 0x80) {
      callback(contents);
    } else {
      utils.readFile_(true, file, callback);
    }
  });
};


/**
 * Reads the contents of the provided file as text and returns them via the
 * provided callback.
 * @param {boolean} asText If true, then read as text.
 * @param {(string|!File)} file The file to read. If it's a string, call the
 *     callback immediately.
 * @param {!function(string)} callback The callback to invoke with the file's
 *     contents.
 * @private
 */
utils.readFile_ = function(asText, file, callback) {
  if (typeof file === 'string') {
    callback(/** @type {string} */ (file));
    return;
  }
  var reader = new FileReader();
  reader.onload = function() {
    if (reader.readyState !== reader.LOADING) {
      reader.onload = null;
      callback(/** @type {string} */ (reader.result));
    }
  };
  if (asText) {
    reader.readAsText(file);
  } else {
    reader.readAsBinaryString(file);
  }
};


/**
 * Logs errors to console.
 * @param {*} error The error to log.
 */
utils.errorHandler = function(error) {
  window.console.error(error);
};



/**
 * Constructor for a i18n friendly error.
 * @param {string} defaultMsg The default error message.
 * @param {string} msgId The i18n message id.
 * @constructor
 * @extends {Error}
 */
utils.Error = function(defaultMsg, msgId) {
  goog.base(this, defaultMsg);
  this.messageId = msgId;
};
goog.inherits(utils.Error, Error);


/**
 * Displays Chrome notifications to the user.
 * @param {string} msg The message to display to the user.
 * @param {!function()} callback A callback to invoke when the notification
 *     has been displayed.
 */
utils.showNotification = function(msg, callback) {
  chrome.notifications.create(constants.ElementId.NOTIFICATION_SUCCESS, {
    type: 'basic',
    iconUrl: '/images/yahoo/icon-48.png',
    title: chrome.i18n.getMessage('extName'),
    message: msg
  }, function() {
    window.setTimeout(function() {
      chrome.notifications.clear(
          constants.ElementId.NOTIFICATION_SUCCESS,
          goog.nullFunction); // Dummy callback to keep Chrome happy.
    }, constants.NOTIFICATIONS_DELAY);
    callback();
  });
};


/**
* Sends a request to the launcher to perform some action.
* @param {messages.ApiRequest} args The message we wish to send to the launcher
* @param {function(messages.e2ebindResponse)=} opt_callback optional callback
*   to call with the result.
*/
utils.sendExtensionRequest = function(args, opt_callback) {
  var port = chrome.runtime.connect();
  port.postMessage(args);

  var respHandler = function(response) {
    if (opt_callback) {
      opt_callback(response);
    }
    port.disconnect();
  };
  port.onMessage.addListener(respHandler);
  port.onDisconnect.addListener(function() {
    port = null;
  });
};


/**
 * Sends a request from a content script to proxy a message to the active tab.
 * @param {messages.proxyMessage} args The message to proxy
 */
utils.sendProxyRequest = function(args) {
  args.proxy = true;
  chrome.runtime.sendMessage(args);
};

});  // goog.scope

