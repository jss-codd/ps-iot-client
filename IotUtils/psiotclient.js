/**
 * Copyright 2017, Algomedica, Inc.
 */

'use strict';

// [START iot_mqtt_include]
let fs = require('fs');
let path = require('path');
let { google } = require('googleapis');
let jwt = require('jsonwebtoken');
let mqtt = require('mqtt');
let psutils = require('./psutils');
let { execSync } = require('child_process');
let SingleInstance = require('single-instance');
let log4js = require('log4js');
// [END iot_mqtt_include]

var basedir = path.dirname(process.execPath);
let certDirName = 'cert';
let RSA_PRIVATEKEY = path.join(basedir, certDirName, 'rsa_pri.pem');
let RSA_PUBLICKEY = path.join(basedir, certDirName, 'rsa_pub.pem');
let RSA_CERTIFICATE = path.join(basedir, certDirName, 'rsa_cert.pem');

let iotConfig = JSON.parse(fs.readFileSync(path.join(basedir, '../Resources/iotconfig.json')));

const API_VERSION = 'v1';
const DISCOVERY_API = 'https://cloudiot.googleapis.com/$discovery/rest';

let PROJECTID = iotConfig.projectId;
let REGISTRY = iotConfig.registry;
let CLOUDREGION = iotConfig.cloudRegion;

let selfCleanupFreq = 60000; // one mnute (millisecond)
let opLockDwag = false;
let dwagSession = '.dwagent';
let rcTimeoutS = parseInt(iotConfig.rcTimeoutS);        // sec
let rcTimeoutExtS = parseInt(iotConfig.rcTimeoutExtS);  // sec

// The initial backoff time after a disconnection occurs, in seconds.
const MINIMUM_BACKOFF_TIME = 1;

// The maximum backoff time before giving up, in seconds.
const MAXIMUM_BACKOFF_TIME = 15;

// Whether to wait with exponential backoff before publishing.
let shouldBackoff = false;

// The current backoff time.
let backoffTime = 1;

// Whether an asynchronous publish chain is in progress.
let publishChainInProgress = false;

// Hearbeat frequency
let heartbeatFreqMs = iotConfig.heartbeatFreqMs; // heartbeat every one minute

let isConnected = false;


var certDir = path.join(basedir, certDirName);
fs.access(certDir, function (err) {
  if (err && err.code === 'ENOENT') {
    fs.mkdirSync(certDir); //Create dir in case not found
  }
});


let logfile = path.basename(process.argv[0]) + '.' + psutils.getFormatDate() + '.log';
var logformat = '[%d] %p %m';
log4js.configure({
  appenders: {
    developer: { type: 'dateFile', filename: logfile, layout: { type: 'pattern', pattern: logformat }, maxLogSize: 10485760, backups: 10 }
  },
  categories: {
    default: { appenders: ['developer'], level: iotConfig.loglevel }
  }
});
global.logger = log4js.getLogger('default');
let logger = global.logger;

/////////////////////////
function psDevice(
  deviceId,
  registryId,
  projectId,
  region,
  algorithm,
  privateKeyFile,
  certificateFile,
  metaData,
  mqttBridgeHostname,
  mqttBridgePort
) {
  // [START iot_mqtt_run]

  // The mqttClientId is a unique string that identifies this device.
  // For Google Cloud IoT Core, it must be in the format below.
  const mqttClientId = `projects/${projectId}/locations/${region}/registries/${registryId}/devices/${deviceId}`;

  const locker = new SingleInstance(deviceId);
  logger.debug("deviceId:" + deviceId);
  locker.lock().then(() => {
    logger.debug("process started");
    // Your application code goes here
  }).catch(err => {
    // This block will be executed if the app is already running
    logger.debug("process is already running...");
    logger.error("err: " + err); // it will print out 'An application is already running'
    process.exit(0);
  });


  // With Google Cloud IoT Core, the username field is ignored, however it must be
  // non-empty. The password field is used to transmit a JWT to authorize the
  // device. The "mqtts" protocol causes the library to connect using SSL, which
  // is required for Cloud IoT Core.
  const connectionArgs = {
    host: mqttBridgeHostname,
    port: mqttBridgePort,
    clientId: mqttClientId,
    username: 'unused',
    password: createJwt(projectId, privateKeyFile, algorithm),
    protocol: 'mqtts',
    secureProtocol: 'TLSv1_2_method',
  };

  // Create a client, and connect to the Google MQTT bridge.
  let iatTime = parseInt(Date.now() / 1000);
  let client = mqtt.connect(connectionArgs);

  // Subscribe to the /devices/{device-id}/config topic to receive config updates.
  // Config updates are recommended to use QoS 1 (at least once delivery)
  client.subscribe(`/devices/${deviceId}/config`, { qos: 1 });

  // Subscribe to the /devices/{device-id}/commands/# topic to receive all
  // commands or to the /devices/{device-id}/commands/<subfolder> to just receive
  // messages published to a specific commands folder; we recommend you use
  // QoS 0 (at most once delivery)
  client.subscribe(`/devices/${deviceId}/commands/#`, { qos: 0 });

  // The MQTT topic that this device will publish data to. The MQTT topic name is
  // required to be in the format below. The topic name must end in 'state' to
  // publish state and 'events' to publish telemetry. Note that this is not the
  // same as the device registry's Cloud Pub/Sub topic.
  const mqttHeartbeatTopic = `/devices/${deviceId}/state`;

  client.on('connect', success => {
    logger.debug('connected');
    if (!success) {
      isConnected = false;
      logger.warn('Client not connected...');
    } else {
      if (!publishChainInProgress) {
        publishHBAsync(mqttHeartbeatTopic, client, iatTime, connectionArgs);
      }
      isConnected = true;
      client.subscribe(`/devices/${deviceId}/config`, { qos: 1 });
      client.subscribe(`/devices/${deviceId}/commands/#`, { qos: 0 });
    }
  });

  client.on('close', () => {
    if (isConnected)
      logger.warn('connection closed');
    isConnected = false;
    shouldBackoff = true;
  });

  client.on('error', err => {
    if (isConnected || err.code != 'ENOTFOUND')
      logger.error('error', err.code, err.message);
    if (err.code == 5) {  // Connection refused: Not authorized. New Device??
      // const endpoint = await getClient(opts.serviceAccount);
      getClient(argv.serviceAccount)
        .then((endpoint) => {
          checkCreateDevice(
            endpoint,
            deviceId,
            registryId,
            projectId,
            region,
            certificateFile,
            metaData
          );
        })
        .catch(function (error) {
          logger.error(`psDevice checkCreateDevice: ${error}`);
        });
    }
  });

  client.on('message', (topic, message) => {
    let messageStr = 'Message received: ';
    if (topic === `/devices/${deviceId}/config`) {
      messageStr = 'Config message received: ';
      messageStr += Buffer.from(message, 'base64').toString('ascii');
      logger.debug(messageStr);
    } else if (topic === `/devices/${deviceId}/commands`) {
      handleCommand(client, deviceId, message);
    } // if (topic === `/devices/${deviceId}/config`) {

  });

  client.on('packetsend', () => {
    // Note: logging packet send is very verbose
  });

  setInterval(() => {
    if (opLockDwag) return;
    if (fs.existsSync('/usr/share/dwagent/native/dwagent')) {
      var bRemoveDwag = false;
      if (!fs.existsSync(dwagSession)) {
        logger.warn('dwagent session not found.');
        bRemoveDwag = true;
      }
      else {
        var stmInstall = fs.readFileSync(dwagSession, 'utf8').toString();
        var itmInstall = parseInt(stmInstall);
        if (itmInstall == NaN || stmInstall.length == 0) {
          logger.warn(`dwagent session starting time NaN: ${stmInstall}`);
          bRemoveDwag = true;
        }
        else {
          var diff = Math.floor(Date.now() / 1000) - itmInstall;
          if (diff > rcTimeoutS) {
            var resary = execSync('dwagmonitor monitor.pyc info').toString().split('\n');
            var lines = resary.filter(item => item.includes('Connections'));
            var connections = parseInt(lines[0].split(": ")[1]);
            var toMaxS = rcTimeoutS + rcTimeoutExtS;
            if (connections > 0 && diff <= toMaxS) {
              logger.warn(`dwagent session extension: ${connections} : ${diff} : ${toMaxS}`);
            }
            else {
              logger.warn(`dwagent session timeout: ${diff}`);
              bRemoveDwag = true;
            }
          }
        }
      }

      if (!bRemoveDwag) return;
      try {
        logger.warn('Removing dwagent...');
        var output = execSync('sudo dwaguninstall -silent');
        logger.debug(output.toString());
        if (fs.existsSync(dwagSession)) fs.unlinkSync(dwagSession);
        publishAsync(client, `/devices/${deviceId}/state`, `${deviceId}: remote_connect enable: false; session expired.`);
      }
      catch (err) {
        logger.error(`Unable to remove dwagent: ${err}`);
      }

    }
  }, selfCleanupFreq);
  // [END psDevice]
}

function handleCommand(client, deviceId, message) {
  var cmdmsg = Buffer.from(message, 'base64').toString('ascii');
  logger.debug(cmdmsg);
  try {
    var obj = JSON.parse(cmdmsg);
    if (typeof obj.command === "undefined") {
      logger.warn("undefined command");
      return;
    }

    var opCmd = obj.command.toString().toLowerCase();
    if (opCmd == "update_settings" || opCmd == "update_license") {
      if (typeof obj.bucket === "undefined" || typeof obj.folder === "undefined" || typeof obj.srcfile === "undefined") {
        publishAsync(client, `/devices/${deviceId}/state`, `${deviceId}: ${opCmd} invalid parameter`);
        logger.warn(`${opCmd} invalid parameter`);
        return;
      }

      logger.debug(obj.command + ":" + obj.bucket + ":" + obj.folder + ":" + obj.srcfile);
      var downfile = "../Resources/" + obj.srcfile;
      psutils.downloadFile(obj.bucket, obj.folder + "/" + obj.srcfile, downfile)
        .then(() => {
          var zipEntries = [];
          if (downfile.endsWith('.zip')) {
            logger.debug('Extracting files');
            var AdmZip = require('adm-zip');
            var zip = new AdmZip(downfile);
            zipEntries = zip.getEntries(); // an array of ZipEntry records
            // extracts everything
            zip.extractAllTo(/*target path*/"../Resources", /*overwrite*/true);
          }

          if (opCmd == "update_license") {
            logger.debug('Update license...');

            // TODO: verify license file
            if (!zipEntries.find(f => f.entryName.endsWith(".key"))) {
              throw new Error('Missing .key file');
            }
            if (!zipEntries.find(f => f.entryName.endsWith(".dat"))) {
              throw new Error('Missing .dat file');
            }

            logger.debug('Apply license');
            zipEntries.forEach(function (zipEntry) {
              var filename = "";
              if (zipEntry.entryName.endsWith(".dat")) {
                filename = "../Resources/psinput.dat";
                fs.renameSync("../Resources/" + zipEntry.entryName, filename);
              }
              else if (zipEntry.entryName.endsWith(".key")) {
                filename = "../Resources/data.dat";
                fs.renameSync("../Resources/" + zipEntry.entryName, filename);
              }

              if (filename.length > 0) {
                fs.utimes(filename, new Date(), new Date(), (err) => {
                  if (err) {
                    logger.error(err.stack);
                  }
                });
              }
            });

            logger.debug('Remove downloaded source');
            fs.unlinkSync(downfile);
          }

          publishAsync(client, `/devices/${deviceId}/state`, `${deviceId}: ${opCmd} finished. Restarting server...`);
          stopserver();
          const execOptions = { encoding: 'utf-8', windowsHide: false, shell: process.env.SHELL };
          execSync('./pixelshine start', execOptions);
        })
        .then(() => {
          logger.warn('Exit process');
          // flush the log before exiting the process
          log4js.shutdown(() => { process.exit(0); });
        })
        .catch(function (error) {
          publishAsync(client, `/devices/${deviceId}/state`, `${deviceId}: ${opCmd} failed. Error: ${error}`);
          logger.error(error);
        });
    }
    else if (opCmd == "upload_settings") {
      if (typeof obj.bucket === "undefined" || typeof obj.folder === "undefined") {
        publishAsync(client, `/devices/${deviceId}/state`, `${deviceId}: upload_settings invalid parameter`);
        logger.warn("upload_settings invalid parameter");
        return;
      }

      uploadfiles(deviceId, obj.bucket, obj.folder, "settings", iotConfig.configcollection);
      publishAsync(client, `/devices/${deviceId}/state`, `${deviceId}: upload_settings finished.`);
    }
    else if (opCmd == "upload_logs") {
      if (typeof obj.bucket === "undefined" || typeof obj.folder === "undefined") {
        publishAsync(client, `/devices/${deviceId}/state`, `${deviceId}: upload_logs invalid parameter`);
        logger.warn("upload_logs invalid parameter");
        return;
      }

      // logs of current PS foolder
      var dirPath = path.resolve(process.cwd());
      var files = fs.readdirSync(dirPath);
      var logFiles = files.filter(f => f.includes('.log'));
      // acctest files in home directory
      var homedir = require('os').homedir();
      var homefiles = fs.readdirSync(homedir);
      var atFiles = homefiles.filter(f => f.includes('acctest'));
      for (var k = 0; k < atFiles.length; k++) {
        atFiles[k] = path.join(homedir, atFiles[k]);
        logger.debug(atFiles[k]);
      }

      if (atFiles.length > 0) logFiles = logFiles.concat(atFiles);

      // logs in ../Logs
      var hubLogs = fs.readdirSync('../Logs').filter(f => f.includes('.log'));
      hubLogs.forEach(function (val, index) {
        this[index] = path.join('../Logs', val);
      }, hubLogs);

      if (hubLogs.length > 0) logFiles = logFiles.concat(hubLogs);

      // additional logs
      logFiles = logFiles.concat(iotConfig.additionalLogs.filter(f => fs.existsSync(f)));
      uploadfiles(deviceId, obj.bucket, obj.folder, "logs", logFiles);
      publishAsync(client, `/devices/${deviceId}/state`, `${deviceId}: upload_logs finished.`);
    }
    else if (opCmd == "server_stop") {
      stopserver();
    }
    else if (opCmd == "server_start") {
      // Start the server when it is stopped (1) (running (0) or starting (2))
      try {
        execSync('./amCheck');
        logger.debug(`server is already running`);
        return;
      } catch (err) {
        if (err.status != 1) {
          logger.error(`server is starting: ${err.status}`);
          return;
        }
      }

      var { exec } = require('child_process');
      const execOptions = { encoding: 'utf-8', windowsHide: false, shell: process.env.SHELL };
      exec('./pixelshine start', execOptions, (error, stdout, stderr) => {
        if (error) {
          logger.error(`exec error: ${error}`);
          return;
        }
        logger.debug(`stdout: ${stdout}`);
        logger.debug(`stderr: ${stderr}`);

        logger.warn('Exit process');
        // flush the log before exiting the process
        log4js.shutdown(() => { process.exit(0); });
      })
    }
    else if (opCmd == "server_check") {
      publishAsync(client, `/devices/${deviceId}/state`, `${deviceId}: ${opCmd}: ${serverCheck()}`);
    }
    else if (opCmd == "server_version") {
      publishAsync(client, `/devices/${deviceId}/state`, `${deviceId}: ${opCmd}: ${serverVersion()}`);
    }
    else if (opCmd == "server_license") {
      publishAsync(client, `/devices/${deviceId}/state`, `${deviceId}: ${opCmd}: ${serverLicense()}`);
    }
    else if (opCmd == "server_reset") {
      var { spawn } = require('child_process');

      var out = fs.openSync(logfile, 'a');
      var err = fs.openSync(logfile, 'a');
      var child = spawn('./pixelshine', ['reset'], { detached: true, stdio: ['ignore', out, err] });

      child.on('close', (code) => {
        logger.error(`child process exited with code ${code}`);
      });

      publishAsync(client, `/devices/${deviceId}/state`, `${deviceId}: ${opCmd} finished. Exiting process.`);

      child.unref();

      // Stop Console
      try {
        execSync(`killall amConfig`);
      } catch (err) {
        logger.warn('Could not stop console', err);
      }
      
      logger.warn('Exit process');
      // flush the log before exiting the process
      log4js.shutdown(() => { process.exit(0); });
    }
    else if (opCmd == "remote_connect") {
      try {
        if (opLockDwag == true) throw "dwag under processing.";
        opLockDwag = true;
        // 'aix' 'darwin' 'freebsd' 'linux' 'openbsd' 'sunos''win32'
        if (process.platform != 'linux') throw "invalid platform. Linux only.";
        if (typeof obj.enable === "undefined") throw "invalid parameter: missing enable mode";
        var enable = obj.enable.toLowerCase();
        if (enable != "true" && enable != "false") throw "invalid parameter: invalid enable mode";
        if (enable == "true" && typeof obj.key === "undefined") throw "invalid parameter: missing key";

        var output;
        var pubmsg = `${deviceId}: remote_connect enable: ${enable}`;

        if (fs.existsSync('/usr/bin/dwaguninstall')) {
          logger.debug('Uninstall dwagent...');
          output = execSync('sudo dwaguninstall -silent');
          logger.debug(output.toString());
          if (fs.existsSync(dwagSession)) fs.unlinkSync(dwagSession);
        }

        if (enable == "true") {
          logger.debug('Install dwagent...');
          psutils.checkCopyFile(path.join(__dirname, 'dwagent.sh'), '/tmp/dwagent.sh', 'binary');
          output = execSync('chmod +x /tmp/dwagent.sh');
          output = execSync('sudo /tmp/dwagent.sh -silent key=' + obj.key);
          logger.debug(output.toString());
          output = execSync('rm -f /tmp/dwagent.sh');

          if (fs.existsSync('/usr/share/dwagent/native/dwagsvc')) {
            fs.writeFileSync(dwagSession, Math.floor(Date.now() / 1000));
            pubmsg = pubmsg + `; key: ${obj.key}`;
          }
          else {
            var pubmsg = `${deviceId}: remote_connect enable: false; unable to install.`;
          }
        }

        publishAsync(client, `/devices/${deviceId}/state`, pubmsg);
      }
      catch (cerr) {
        logger.warn('remote_connect: ' + cerr);
        publishAsync(client, `/devices/${deviceId}/state`, `${deviceId}: remote_connect command failed. err: ${cerr}`);
      }
      finally {
        opLockDwag = false;
      }
    }

  }
  catch (err) {
    if (err instanceof SyntaxError) {
      publishAsync(client, `/devices/${deviceId}/state`, `${deviceId}: command failed. Error: ${err.message}`);
      logger.error('SyntaxError: ' + err.message);
    }
    else {
      publishAsync(client, `/devices/${deviceId}/state`, `${deviceId}: command failed. Error: ${err}`);
      logger.error(err);
    }
  }
}

function publishAsync(client, topic, message) {
  client.publish(topic, message, { qos: 1 }, err => {
    if (err) logger.error('Unable to publish message:' + err);
  });
}

function stopserver() {
  const execOptions = { encoding: 'utf-8', windowsHide: false, shell: process.env.SHELL };
  // Canonot call ./pixelshine stop since it also kills amIotClient
  logger.warn('stopserver: stopping server...');

  var procs = ['amMon', 'amServ', 'amRecv', 'amUpload'];
  procs.forEach(p => {
    try {
      execSync(`killall -q ${p}`, execOptions);
      logger.warn(`${p} is stopped`);
    } catch (err) {
      logger.warn('stopserver:', err);
    }
  })

  try {
    execSync('rm -f .pingServ .pingRecv .pingUpload', execOptions);
  } catch (err) {
    logger.warn('stopserver:', err);
  }
  logger.warn('stopserver: stop server done');
}

function serverCheck() {
  var resary = execSync('./pixelshine check').toString().split('\n');
  return resary.filter(item => item.includes('PixelShine Server:'));
}

function serverVersion() {
  var resary = execSync('./pixelshine version').toString().split('\n');
  return resary.filter(item => item.includes('$AlgoMed:'));
}

function serverLicense() {
  var resary = execSync('./pixelshine license').toString().split('\n');
  return resary.filter(item => item.includes('$AlgoMed:'));
}

function uploadfiles(deviceId, dstBucket, dstFolder, type, srcfiles) {
  var now = new Date();
  var timestamp = now.getFullYear().toString() + (now.getMonth() + 1).toString() + now.getDate().toString() +
    now.getHours().toString() + now.getMinutes().toString() + now.getSeconds().toString() + now.getMilliseconds().toString();

  var AdmZip = require('adm-zip');
  var output = `${deviceId}_${type}_${timestamp}.zip`;
  var zip = new AdmZip();
  srcfiles.forEach(f => zip.addLocalFile(f));
  zip.writeZip(output);

  psutils.uploadFile(dstBucket, dstFolder, output)
    .then(() => {
      logger.debug(`${type} uploaded`);
      fs.unlinkSync(output);
    })
    .catch(function (error) {
      logger.error(error);
    });
}

// Returns an authorized API client by discovering the Cloud IoT Core API with
// the provided API key.
const getClient = async serviceAccountJson => {
  // the getClient method looks for the GCLOUD_PROJECT and GOOGLE_APPLICATION_CREDENTIALS
  // environment variables if serviceAccountJson is not passed in
  const authClient = await google.auth.getClient({
    keyFilename: serviceAccountJson,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });

  const discoveryUrl = `${DISCOVERY_API}?version=${API_VERSION}`;

  google.options({
    auth: authClient,
  });

  try {
    return google.discoverAPI(discoveryUrl);
  } catch (err) {
    logger.error('Error during API discovery.', err);
  }
};


// Create a Cloud IoT Core JWT for the given project id, signed with the given
// private key.
// [START iot_mqtt_jwt]
function createJwt(projectId, privateKeyFile, algorithm) {
  // Create a JWT to authenticate this device. The device will be disconnected
  // after the token expires, and will have to reconnect with a new token. The
  // audience field should always be set to the GCP project id.
  const token = {
    iat: parseInt(Date.now() / 1000),
    exp: parseInt(Date.now() / 1000) + 1440 * 60, // 20 minutes
    aud: projectId,
  };
  const privateKey = fs.readFileSync(privateKeyFile);
  return jwt.sign(token, privateKey, { algorithm: algorithm });
}
// [END iot_mqtt_jwt]
/////////////////////////


// Publish messages asynchronously
// [START iot_mqtt_publish_heartbeat]
function publishHBAsync(
  mqttTopic,
  client,
  iatTime,
  connectionArgs
) {
  // If we have published enough messages or backed off too many times, stop.
  if (backoffTime >= MAXIMUM_BACKOFF_TIME) {
    if (backoffTime >= MAXIMUM_BACKOFF_TIME) {
      // logger.error('Backoff time is too high. Giving up.');
      logger.warn(`publishHBAsync: Backoff time is over ${MAXIMUM_BACKOFF_TIME}`);
      backoffTime = MINIMUM_BACKOFF_TIME;
    }
    // logger.warn('Closing connection to MQTT. Goodbye!');
    // client.end();
    publishChainInProgress = false;
    return;
  }

  // Publish and schedule the next publish.
  publishChainInProgress = true;
  let publishDelayMs = 0;
  if (shouldBackoff) {
    publishDelayMs = 1000 * (backoffTime + Math.random());
    backoffTime *= 2;
    logger.debug(`publishHBAsync: Backing off for ${publishDelayMs}ms before publishing.`);
  }

  setTimeout(() => {
    var localip = psutils.getLocalIP();
    if (localip.length <= 0 || !isConnected) {
      logger.debug('publishHBAsync: no local IP detected or device not online. Skip heartbeat...');
    }
    else {
      var heartbeatMsg = `${argv.deviceId}: status: ${serverCheck()}; IP: ${localip}`;

      // Publish "payload" to the MQTT topic. qos=1 means at least once delivery.
      // Cloud IoT Core also supports qos=0 for at most once delivery.
      logger.debug(new Date().toLocaleString() + ":" + heartbeatMsg);
      client.publish(mqttTopic, heartbeatMsg, { qos: 1 }, err => {
        if (!err) {
          shouldBackoff = false;
          backoffTime = MINIMUM_BACKOFF_TIME;
        }
      });
    }

    setTimeout(() => {
      // [START iot_mqtt_jwt_refresh]
      const secsFromIssue = parseInt(Date.now() / 1000) - iatTime;
      if (secsFromIssue > argv.tokenExpMins * 60) {
        iatTime = parseInt(Date.now() / 1000);
        logger.warn(`\tRefreshing token after ${secsFromIssue} seconds.`);

        client.end();
        connectionArgs.password = createJwt(
          argv.projectId,
          argv.privateKeyFile,
          argv.algorithm
        );
        connectionArgs.protocolId = 'MQTT';
        connectionArgs.protocolVersion = 4;
        connectionArgs.clean = true;
        client = mqtt.connect(connectionArgs);

        client.subscribe(`/devices/${argv.deviceId}/config`, { qos: 1 });
        client.subscribe(`/devices/${argv.deviceId}/commands/#`, { qos: 0 });
        // [END iot_mqtt_jwt_refresh]

        client.on('connect', success => {
          logger.debug('connected');
          if (!success) {
            isConnected = false;
            logger.warn('Client not connected...');
          } else {
            if (!publishChainInProgress) {
              publishHBAsync(mqttTopic, client, iatTime, connectionArgs);
            }
            isConnected = true;
            client.subscribe(`/devices/${deviceId}/config`, { qos: 1 });
            client.subscribe(`/devices/${deviceId}/commands/#`, { qos: 0 });
          }
        });

        client.on('close', () => {
          if (isConnected)
            logger.warn('connection closed');
          isConnected = false;
          // shouldBackoff = true;
        });

        client.on('error', err => {
          if (isConnected || err.code != 'ENOTFOUND')
            logger.error('error', err.code, err.message);
        });

        client.on('message', (topic, message) => {
          let messageStr = 'Message received: ';
          logger.debug(topic + " : " + topic + "\n" + message);
          if (topic === `/devices/${argv.deviceId}/config`) {
            messageStr = 'Config message received: ';
            messageStr += Buffer.from(message, 'base64').toString('ascii');
            logger.debug(messageStr);
          } else if (topic === `/devices/${argv.deviceId}/commands`) {
            handleCommand(client, deviceId, message);
          }
        });

        client.on('packetsend', () => {
          // Note: logging packet send is very verbose
        });
      }
      publishHBAsync(
        mqttTopic,
        client,
        iatTime,
        connectionArgs
      );
    }, heartbeatFreqMs);
  }, publishDelayMs);
}
// [END iot_mqtt_publish]

// Attaches a device to a gateway.
function attachDevice(deviceId, client, jwt) {
  // [START attach_device]
  // const deviceId = 'my-unauth-device';
  const attachTopic = `/devices/${deviceId}/attach`;
  logger.debug(`Attaching: ${attachTopic}`);
  let attachPayload = '{}';
  if (jwt && jwt !== '') {
    attachPayload = `{ 'authorization' : ${jwt} }`;
  }

  client.publish(attachTopic, attachPayload, { qos: 1 }, err => {
    if (!err) {
      shouldBackoff = false;
      backoffTime = MINIMUM_BACKOFF_TIME;
    } else {
      logger.error(err);
    }
  });
  // [END attach_device]
}

// Detaches a device from a gateway.
function detachDevice(deviceId, client, jwt) {
  // [START detach_device]
  const detachTopic = `/devices/${deviceId}/detach`;
  logger.debug(`Detaching: ${detachTopic}`);
  let detachPayload = '{}';
  if (jwt && jwt !== '') {
    detachPayload = `{ 'authorization' : ${jwt} }`;
  }

  client.publish(detachTopic, detachPayload, { qos: 1 }, err => {
    if (!err) {
      shouldBackoff = false;
      backoffTime = MINIMUM_BACKOFF_TIME;
    } else {
      logger.error(err);
    }
  });
  // [END detach_device]
}

// Retrieve the given device from the registry.
const checkCreateDevice = async (
  client,
  deviceId,
  registryId,
  projectId,
  cloudRegion,
  rsaCertificateFile,
  metadata
) => {
  // [START iot_get_device]
  // Client retrieved in callback
  // getClient(serviceAccountJson, function(client) {...});
  // const cloudRegion = 'us-central1';
  // const deviceId = 'my-device';
  // const projectId = 'adjective-noun-123';
  // const registryId = 'my-registry';

  const parentName = `projects/${projectId}/locations/${cloudRegion}`;
  const registryName = `${parentName}/registries/${registryId}`;
  const clientid = `${registryName}/devices/${deviceId}`;
  var request = {
    name: clientid,
  };

  try {
    const { data } = await client.projects.locations.registries.devices.get(
      request
    );

    logger.debug('Found device:', deviceId);
    if (argv.verbose) {
      logger.debug(data);
    }

    var swVer = JSON.parse(metadata).version;
    // Version changed. Update metadata
    if (swVer != data.metadata.version) {
      logger.debug(`version different: local:${swVer} ; server:${data.metadata.version}`);

      // Update server configuration
      data.metadata.version = swVer;
      request = {
        name: clientid,
        updateMask: 'metadata',
        fields: 'metadata',
        resource: {
          metadata: data.metadata
        }
      };
      const { meta } = await client.projects.locations.registries.devices.patch(
        request
      );
      logger.debug('metadata updated');
    }
  } catch (err) {
    logger.warn('checkCreateDevice: Could not find device:', deviceId, 'code:' + err.code);
    if (argv.verbose) {
      logger.error(`checkCreateDevice: ${err}`);
    }

    if (err.code == '404') {
      if (!psutils.isValdiFile(RSA_PRIVATEKEY) || !psutils.isValdiFile(RSA_PRIVATEKEY) || !psutils.isValdiFile(RSA_PRIVATEKEY)) {
        psutils.RSAKeyGen(RSA_PRIVATEKEY, RSA_PUBLICKEY, RSA_CERTIFICATE);
      }
      await createRsaDevice(
        client,
        deviceId,
        registryId,
        projectId,
        cloudRegion,
        rsaCertificateFile,
        metadata
      );
    }
  }
  // [END checkCreateDevice]
};

// Create a device using RSA256 for authentication.
const createRsaDevice = async (
  client,
  deviceId,
  registryId,
  projectId,
  cloudRegion,
  rsaCertificateFile,
  metadata
) => {
  // [START iot_create_rsa_device]
  // Client retrieved in callback
  // getClient(serviceAccountJson, function(client) {...});
  const parentName = `projects/${projectId}/locations/${cloudRegion}`;
  const registryName = `${parentName}/registries/${registryId}`;
  const body = {
    id: deviceId,
    credentials: [
      {
        publicKey: {
          format: 'RSA_X509_PEM',
          key: fs.readFileSync(rsaCertificateFile).toString(),
        },
      },
    ],
  };

  if (metadata !== undefined && metadata.length > 0) {
    logger.debug(metadata);
    body.metadata = JSON.parse(metadata);
  }

  logger.debug(JSON.stringify(body));
  const request = {
    parent: registryName,
    resource: body,
  };

  logger.debug(JSON.stringify(request));

  try {
    const { data } = await client.projects.locations.registries.devices.create(
      request
    );

    logger.debug('Created device');
    logger.debug(data);
  } catch (err) {
    logger.error('Could not create device');
    logger.error(err);
  }
  // [END iot_create_rsa_device]
};

function publishMsgAsync(
  deviceId,
  registryId,
  projectId,
  region,
  algorithm,
  privateKeyFile,
  mqttBridgeHostname,
  mqttBridgePort,
  topic,  // state or events
  message
) {
  const clientId = `projects/${projectId}/locations/${region}/registries/${registryId}/devices/${deviceId}`;

  const connectionArgs = {
    host: mqttBridgeHostname,
    port: mqttBridgePort,
    clientId: clientId,
    username: 'unused',
    password: createJwt(projectId, privateKeyFile, algorithm),
    protocol: 'mqtts',
    secureProtocol: 'TLSv1_2_method',
  };


  // // Create a client, and connect to the Google MQTT bridge.
  var mclient = mqtt.connect(connectionArgs);
  mclient.on('error', err => {
    logger.error('error', err.code, err.message);
  });
  mclient.on('close', () => {
    if (isConnected)
      logger.warn('connection closed');
    isConnected = false;
    shouldBackoff = true;
  });

  mclient.on('connect', success => {
    logger.debug('publishMsgAsync: connected');
    if (!success) {
      isConnected = false;
      logger.warn('publishMsgAsync: client not connected...');
    } else {
      try {
        isConnected = true;
        const msgtopic = `/devices/${deviceId}/${topic}`;
        logger.debug(`publishMsgAsync: try publishing topic:${msgtopic} ; message:${deviceId}: ${message}`);
        mclient.publish(msgtopic, deviceId + ": " + message, { qos: 1 }, err => {
          if (err) {
            logger.debug('publishMsgAsync:', err);
          }
          process.exit(0);
        });
        logger.debug('publishMsgAsync: done');
      }
      catch (err) {
        logger.debug('publishMsgAsync: publish err:' + err);
      }
    }
  });
}



const { argv } = require('yargs') // eslint-disable-line
  .options({
    projectId: {
      alias: 'p',
      default: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || PROJECTID,
      description:
        'The Project ID to use. Defaults to the value of the GCLOUD_PROJECT or GOOGLE_CLOUD_PROJECT environment variables.',
      requiresArg: true,
      type: 'string',
    },
    cloudRegion: {
      alias: 'c',
      default: process.env.GLOUD_REGION || process.env.GOOGLE_CLOUD_REGION || CLOUDREGION,
      description: 'GCP cloud region.',
      requiresArg: true,
      type: 'string',
    },
    registryId: {
      alias: 'r',
      default: process.env.GLOUD_REGISTRY || process.env.GOOGLE_CLOUD_REGISTRY || REGISTRY,
      description: 'Cloud IoT registry ID.',
      requiresArg: true,
      type: 'string',
    },
    deviceId: {
      alias: 'd',
      description: 'Cloud IoT device ID.',
      requiresArg: true,
      // demandOption: false,
      type: 'string',
    },
    serviceAccount: {
      alias: 's',
      default: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      description: 'The path to your service credentials JSON.',
      requiresArg: true,
      type: 'string',
    },
    tokenExpMins: {
      default: 1440,
      description: 'Minutes to JWT token expiration.',
      requiresArg: true,
      type: 'number',
    },
    mqttBridgeHostname: {
      default: iotConfig.mqttBridgeHostname,
      description: 'MQTT bridge hostname.',
      requiresArg: true,
      type: 'string',
    },
    mqttBridgePort: {
      default: iotConfig.mqttBridgePort,
      description: 'MQTT bridge port.',
      requiresArg: true,
      type: 'number',
    },
    verbose: {
      alias: 'v',
    }
  })
  .command(
    `psDevice`,
    `Connects PS as a device, sends data, and receives data`,
    {
      privateKeyFile: {
        alias: 'k',
        default: RSA_PRIVATEKEY,
        description: 'Path to private key file.',
        requiresArg: true,
        // demandOption: true,
        type: 'string',
      },
      algorithm: {
        alias: 'a',
        description: 'Encryption algorithm to generate the JWT.',
        requiresArg: true,
        // demandOption: true,
        choices: ['RS256', 'ES256'],
        type: 'string',
      },
      metaData: {
        alias: 'm',
        default: "{}",
        description: 'metadata of the device',
        requiresArg: true,
        // demandOption: true,
        type: 'string',
      },
      certificateFile: {
        alias: 't',
        default: RSA_CERTIFICATE,
        description: 'certificte file',
        requiresArg: true,
        // demandOption: true,
        type: 'string',
      }
    },
    opts => {
      psDevice(
        opts.deviceId,
        opts.registryId,
        opts.projectId,
        opts.cloudRegion,
        opts.algorithm,
        opts.privateKeyFile,
        opts.certificateFile,
        opts.metaData,
        opts.mqttBridgeHostname,
        opts.mqttBridgePort
      );
    }
  )
  .command(
    `checkCreateDevice`,
    `Check and Creates an RSA256 device if not exist.`,
    {
      metaData: {
        alias: 'm',
        default: "{}",
        description: 'metadata of the device',
        requiresArg: true,
        // demandOption: true,
        type: 'string',
      },
      certificateFile: {
        alias: 't',
        default: RSA_CERTIFICATE,
        description: 'certificte file',
        requiresArg: true,
        // demandOption: true,
        type: 'string',
      }
    },
    async opts => {
      try {
        const client = await getClient(opts.serviceAccount);
        await checkCreateDevice(
          client,
          opts.deviceId,
          opts.registryId,
          opts.projectId,
          opts.cloudRegion,
          opts.certificateFile, // certificate
          opts.metaData
        );
      }
      catch (err) {
        logger.error('Error: ', err.code, err.message)
      }
    }
  )
  .command(
    `publishMsgAsync`,
    `Public message to a topic`,
    {
      privateKeyFile: {
        alias: 'k',
        default: RSA_PRIVATEKEY,
        description: 'Path to private key file.',
        requiresArg: true,
        // demandOption: true,
        type: 'string',
      },
      algorithm: {
        alias: 'a',
        description: 'Encryption algorithm to generate the JWT.',
        requiresArg: true,
        // demandOption: true,
        choices: ['RS256', 'ES256'],
        type: 'string',
      },
      topic: {
        alias: 'tp',
        description: 'topic of the message.',
        requiresArg: true,
        choices: ['state', 'events'],
        type: 'string',
      },
      message: {
        alias: 'msg',
        description: 'Message to publish.',
        requiresArg: true,
        type: 'string',
      }
    },
    opts => {
      publishMsgAsync(
        opts.deviceId,
        opts.registryId,
        opts.projectId,
        opts.cloudRegion,
        opts.algorithm,
        opts.privateKeyFile,
        opts.mqttBridgeHostname,
        opts.mqttBridgePort,
        opts.topic,
        opts.message
      );
    }
  )
  .command(
    `upload <bucketName> <destFolder> <srcFileName>`,
    `Uploads a local file to a bucket.`,
    {},
    // opts => uploadFile(opts.bucketName, opts.destFolder, opts.srcFileName)
    opts => psutils.uploadFile(opts.bucketName, opts.destFolder, opts.srcFileName)
  )
  .example(
    `node $0 psDevice -p=ps-iot -r=PSRegistry -d=my-device-id -k=cert/rsa_pri.pem -a=RS256 -t=cert/rsa_cert.pem -m="{\"Name\":\"Hospital\", \"Adderss\":\"my address\"}" `
  )
  .example(
    `node $0 checkCreateDevice -p=ps-iot -d=ps_F018983A0825 -r=PSRegistry -m="{\"Name\":\"Hospital\", \"Adderss\":\"my address\"}" -t=cert/rsa_cert.pem`
  )
  .wrap(180)
  .recommendCommands()
  .help()
  .strict();
