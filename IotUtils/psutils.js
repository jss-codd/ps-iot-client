let fs = require('fs');
let path = require('path');
let log4js = require('log4js');
const { execSync } = require('child_process');


global.logger = log4js.getLogger('default');
let logger = global.logger;


/**
 * Generating an RSA key with a self-signed X.509 certificate
 * Also generate a publickey ot of the private
 */
function RSAKeyGen(privatekey, publickey, certificate) {
  const execOptions = { encoding: 'utf-8', windowsHide: true };

  if (fs.existsSync(privatekey)) fs.unlinkSync(privatekey);
  if (fs.existsSync(publickey)) fs.unlinkSync(publickey);
  if (fs.existsSync(certificate)) fs.unlinkSync(certificate);

  execSync('openssl version', execOptions);
  execSync(
    // `openssl req -x509 -newkey rsa:2048 -keyout ${privatekey} -out ${certificate} -days 3650 -nodes -subj "/C=US/ST=CA/L=Sunnyvale/O=AlgoMedica/CN=PixelShine"`,
    `openssl req -x509 -newkey rsa:2048 -keyout ${privatekey} -out ${certificate} -days 36500 -nodes -subj "/CN=unused"`,
    execOptions
  );
  execSync(`openssl rsa -in ${privatekey} -pubout -out ${publickey}`, execOptions);
  // execSync('rm ./certs/key.tmp.pem', execOptions);
}

/**
 * Generating an ES256 key with a self-signed X.509 certificate
 * Generating an Elliptic Curve keys
 */
function ECKeyGen(privatekey, publickey, certificate) {
  const execOptions = { encoding: 'utf-8', windowsHide: true };
  execSync('openssl version', execOptions);
  execSync('openssl ecparam -genkey -name prime256v1 -noout -out ' + privatekey, execOptions);
  // execSync('openssl ec -in ec_private.pem -pubout -out ' + publickey, execOptions);
  execSync('openssl ec -in ' + privatekey + ' -pubout -out ' + publickey, execOptions);
  execSync(
    `openssl req -x509 -new -key ${privatekey} -out ${certificate} -days 36500 -subj "/CN=unused"`,
    execOptions
  );
  // execSync('rm ./certs/key.tmp.pem', execOptions);
}


async function downloadFile(bucketName, srcFilename, destFilename) {
  // [START storage_download_file]
  // Imports the Google Cloud client library
  const { Storage } = require('@google-cloud/storage');

  // Creates a client
  const storage = new Storage();

  /**
   * TODO(developer): Uncomment the following lines before running the sample.
   */
  // const bucketName = 'Name of a bucket, e.g. my-bucket';
  // const srcFilename = 'Remote file to download, e.g. file.txt';
  // const destFilename = 'Local destination for file, e.g. ./local/path/to/file.txt';

  const options = {
    // The path to which the file should be downloaded, e.g. "./file.txt"
    destination: destFilename,
  };

  // Downloads the file
  await storage
    .bucket(bucketName)
    .file(srcFilename)
    .download(options);

  logger.debug(
    `gs://${bucketName}/${srcFilename} downloaded to ${destFilename}.`
  );
  // [END storage_download_file]
}

async function uploadFile(bucketName, folder, filename) {
  // [START storage_upload_file]
  // Imports the Google Cloud client library
  const { Storage } = require('@google-cloud/storage');

  // Creates a client
  const storage = new Storage();

  // Uploads a local file to the bucket
  await storage.bucket(bucketName).upload(filename, {
    // Support for HTTP requests made with `Accept-Encoding: gzip`
    gzip: true,
    destination: '/' + folder + '/' + filename,
    // By setting the option `destination`, you can change the name of the
    // object you are uploading to a bucket.
    metadata: {
      // Enable long-lived HTTP caching headers
      // Use only if the contents of the file will never change
      // (If the contents will change, use cacheControl: 'no-cache')
      cacheControl: 'public, max-age=31536000',
    },
  });

  logger.debug(`${filename} uploaded to ${bucketName}.`);
  // [END storage_upload_file]
}

function getFormatDate() {
  var d = new Date(),
    month = '' + (d.getMonth() + 1),
    day = '' + d.getDate(),
    year = d.getFullYear();

  if (month.length < 2)
    month = '0' + month;
  if (day.length < 2)
    day = '0' + day;

  return [year, month, day].join('');
}

function getLocalIP() {
  // Public IPv4 and IPv6 of eth0 as an Array
  var os = require('os');
  var networkInterfaces = Object.values(os.networkInterfaces())
    .reduce((r, a) => {
      r = r.concat(a)
      return r;
    }, [])
    .filter(({ family, address }) => {
      return family.toLowerCase().indexOf('v4') >= 0 &&
        address !== '127.0.0.1'
    })
    .map(({ address }) => address);
  var ipAddresses = networkInterfaces.join(', ');
  return ipAddresses;
}

//type: 'binary' or 'utf-8'
function checkCopyFile(src, dest, type) {
  var bRet = false;
  try {
    if (!fs.existsSync(dest)) {
      var buffer = fs.readFileSync(src, type);
      fs.writeFileSync(dest, buffer, type);
    }
    bRet = true;
  }
  catch (error) {
    logger.error(`Unable to copy file: ${src}. \n ${error}`);
  }
}

// Return true if file exists and files size is not 0 byte; false otherwise
function isValdiFile(filepath)
{
  return fs.existsSync(filepath) && fs.statSync(filepath)["size"] > 0;
}

module.exports = {
  RSAKeyGen: RSAKeyGen,
  ECKeyGen: ECKeyGen,
  downloadFile: downloadFile,
  uploadFile: uploadFile,
  getFormatDate: getFormatDate,
  getLocalIP: getLocalIP,
  checkCopyFile: checkCopyFile,
  isValdiFile: isValdiFile
};