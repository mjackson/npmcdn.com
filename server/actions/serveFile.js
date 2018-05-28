const fs = require("fs");
const path = require("path");
const etag = require("etag");
const babel = require("babel-core");

const IndexPage = require("../components/IndexPage");
const unpkgRewrite = require("../plugins/unpkgRewrite");
const renderPage = require("../utils/renderPage");
const getMetadata = require("../utils/getMetadata");
const getFileContentType = require("../utils/getFileContentType");
const getEntries = require("../utils/getEntries");

/**
 * Automatically generate HTML pages that show package contents.
 */
const AutoIndex = !process.env.DISABLE_INDEX;

/**
 * Maximum recursion depth for meta listings.
 */
const MaximumDepth = 128;

function serveMetadata(req, res) {
  getMetadata(
    req.packageDir,
    req.filename,
    req.stats,
    MaximumDepth,
    (error, metadata) => {
      if (error) {
        console.error(error);

        res
          .status(500)
          .type("text")
          .send(
            `Cannot generate metadata for ${req.packageSpec}${req.filename}`
          );
      } else {
        // Cache metadata for 1 year.
        res
          .set({
            "Cache-Control": "public, max-age=31536000",
            "Cache-Tag": "meta"
          })
          .send(metadata);
      }
    }
  );
}

function rewriteBareModuleIdentifiers(file, packageConfig, callback) {
  const dependencies = Object.assign(
    {},
    packageConfig.peerDependencies,
    packageConfig.dependencies
  );

  const options = {
    // Ignore .babelrc and package.json babel config
    // because we haven't installed dependencies so
    // we can't load plugins; see #84
    babelrc: false,
    plugins: [unpkgRewrite(dependencies)]
  };

  babel.transformFile(file, options, (error, result) => {
    callback(error, result && result.code);
  });
}

function serveJavaScriptModule(req, res) {
  if (getFileContentType(req.filename) !== "application/javascript") {
    return res
      .status(403)
      .type("text")
      .send("?module mode is available only for JavaScript files");
  }

  const file = path.join(req.packageDir, req.filename);

  rewriteBareModuleIdentifiers(file, req.packageConfig, (error, code) => {
    if (error) {
      console.error(error);

      const errorName = error.constructor.name;
      const errorMessage = error.message.replace(
        /^.*?\/unpkg-.+?\//,
        `/${req.packageSpec}/`
      );
      const codeFrame = error.codeFrame;
      const debugInfo = `${errorName}: ${errorMessage}\n\n${codeFrame}`;

      res
        .status(500)
        .type("text")
        .send(
          `Cannot generate module for ${req.packageSpec}${
            req.filename
          }\n\n${debugInfo}`
        );
    } else {
      // Cache modules for 1 year.
      res
        .set({
          "Content-Type": "application/javascript; charset=utf-8",
          "Content-Length": Buffer.byteLength(code),
          "Cache-Control": "public, max-age=31536000",
          "Cache-Tag": "file,js-file,js-module"
        })
        .send(code);
    }
  });
}

function serveStaticFile(req, res) {
  // look whether html param exists
  const html = req.query.html != undefined ? true : false;
  console.log(
    `Trying to send ${req.packageSpec}${req.filename} ${
      html ? "as html page" : "as file"
    }`
  );
  const tags = ["file"];

  const ext = path.extname(req.filename).substr(1);
  if (ext) {
    tags.push(`${ext}-file`);
  }

  let contentType = getFileContentType(req.filename);
  if (contentType === "application/javascript") {
    contentType += "; charset=utf-8";
  }

  // Cache files for 1 year.
  res.set({
    "Content-Length": req.stats.size,
    "Cache-Control": "public, max-age=31536000",
    "Last-Modified": req.stats.mtime.toUTCString(),
    ETag: etag(req.stats),
    "Cache-Tag": tags.join(",")
  });

  const file = path.join(req.packageDir, req.filename);
  const stream = fs.createReadStream(file);

  stream.on("error", error => {
    console.error(`Cannot send file ${req.packageSpec}${req.filename}`);
    console.error(error);
    res.sendStatus(500);
  });

  let chunks = [];
  let codeString = "";
  // IF HTML: push file content chunk-wise from stream to array
  stream.on("data", chunk => {
    if (html) {
      chunks.push(chunk);
    }
  });

  // IF HTML: return syntax highlighted code as html
  stream.on("close", () => {
    if (html) {
      // turn chunk-array to string
      codeString = Buffer.concat(chunks).toString();
      // html template using highlight.js
      let highlightStyle = "default";
      let html = ` 
        <html>
        <head>
        <link rel="stylesheet" type="text/css" href="//cdnjs.cloudflare.com/ajax/libs/highlight.js/9.12.0/styles/${highlightStyle}.min.css">
        <script src="//cdnjs.cloudflare.com/ajax/libs/highlight.js/9.12.0/highlight.min.js"></script>
        <script src="//cdnjs.cloudflare.com/ajax/libs/highlightjs-line-numbers.js/2.3.0/highlightjs-line-numbers.min.js"></script>
        <script>hljs.initHighlightingOnLoad();hljs.initLineNumbersOnLoad();</script> 
        <style>td.hljs-ln-numbers{text-align:center;color:#ccc;border-right:1px solid #999;vertical-align:top;padding-right:5px;-webkit-touch-callout:none;-webkit-user-select:none;-khtml-user-select:none;-moz-user-select:none;-ms-user-select:none;user-select:none}td.hljs-ln-code{padding-left:10px}code{white-space:pre-wrap;overflow:auto}</style>
        </head>
        <body>
        <pre><code>${codeString}</code></pre>
        </body>
        </html>`;
      // send back html
      res.send(html);
    }
  });

  // send back the file if there is no html parameter given
  if (!html) {
    stream.pipe(res);
  }
}

function serveIndex(req, res) {
  const dir = path.join(req.packageDir, req.filename);

  getEntries(dir).then(
    entries => {
      const html = renderPage(IndexPage, {
        packageInfo: req.packageInfo,
        version: req.packageVersion,
        dir: req.filename,
        entries
      });

      // Cache HTML directory listings for 1 minute.
      res
        .set({
          "Cache-Control": "public, max-age=60",
          "Cache-Tag": "index"
        })
        .send(html);
    },
    error => {
      console.error(error);

      res
        .status(500)
        .type("text")
        .send(`Cannot read entries for ${req.packageSpec}${req.filename}`);
    }
  );
}

/**
 * Send the file, JSON metadata, or HTML directory listing.
 */
function serveFile(req, res) {
  if (req.query.meta != null) {
    serveMetadata(req, res);
  } else if (req.stats.isFile()) {
    if (req.query.module != null) {
      serveJavaScriptModule(req, res);
    } else {
      serveStaticFile(req, res);
    }
  } else if (req.stats.isDirectory() && AutoIndex) {
    serveIndex(req, res);
  } else {
    res
      .status(403)
      .type("text")
      .send(`Cannot serve ${req.packageSpec}${req.filename}; it's not a file`);
  }
}

module.exports = serveFile;
