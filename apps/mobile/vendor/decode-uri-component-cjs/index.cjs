'use strict';

// query-string 7 expects require('decode-uri-component') to return a function.
// Upstream 0.5.1 fixes both DoS advisories but exports that function as ESM.
// Keep upstream code intact and expose its default through the legacy contract.
module.exports = require('decode-uri-component-upstream').default;
