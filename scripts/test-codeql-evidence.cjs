const assert = require('node:assert/strict');
const { summarizeSarif } = require('./codeql-evidence.cjs');
function scenarios() {
  const physical = { artifactLocation: { uri: 'apps/api/src/example.ts' }, region: { startLine: 12, endLine: 14, snippet: { text: 'DO_NOT_LOG_SNIPPET' } } };
  const report = { runs: [{ tool: { driver: { rules: [{ id: 'js/example', properties: { 'security-severity': '8.1' }, defaultConfiguration: { level: 'warning' } }] } }, results: [{ ruleId: 'js/example', message: { text: 'DO_NOT_LOG_MESSAGE' }, locations: [{ physicalLocation: physical }], codeFlows: [{ threadFlows: [{ locations: [{ location: { physicalLocation: physical, message: { text: 'DO_NOT_LOG_FLOW_MESSAGE' } } }] }] }], fixes: [{ description: { text: 'DO_NOT_LOG_FIX' } }] }] }] };
  return [
    { name: 'records rule severity and exact primary/dataflow file locations', run() {
      const rows = summarizeSarif(report);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].securitySeverity, '8.1');
      assert.deepEqual(rows[0].locations, [{ path: 'apps/api/src/example.ts', line: 12, endLine: 14 }]);
      assert.deepEqual(rows[0].flows, [rows[0].locations]);
    } },
    { name: 'does not emit snippets, messages, fixes or unrelated report content', run() {
      assert.doesNotMatch(JSON.stringify(summarizeSarif(report)), /DO_NOT_LOG/);
    } },
    { name: 'supports indexed rule and artifact references without reading artifact files', run() {
      const rows = summarizeSarif({ runs: [{ tool: report.runs[0].tool, artifacts: [{ location: { uri: 'indexed.ts' }, contents: { text: 'DO_NOT_LOG' } }], results: [{ ruleIndex: 0, locations: [{ physicalLocation: { artifactLocation: { index: 0 }, region: { startLine: 7 } } }] }] }] });
      assert.equal(rows[0].rule, 'js/example');
      assert.equal(rows[0].locations[0].path, 'indexed.ts');
      assert.doesNotMatch(JSON.stringify(rows), /DO_NOT_LOG/);
    } },
    { name: 'JSON framing prevents source metadata becoming a workflow command', run() {
      const rows = summarizeSarif({ runs: [{ results: [{ ruleId: '\n::warning::not a workflow command' }] }] });
      assert.equal(JSON.stringify(rows[0]).split('\n').length, 1);
    } },
    { name: 'missing scan structure fails instead of reporting a clean scan', run() {
      assert.throws(() => summarizeSarif({}), /runs are missing/);
      assert.deepEqual(summarizeSarif({ runs: [{ results: [] }] }), []);
    } },
  ];
}
module.exports = { scenarios };
if (require.main === module) {
  for (const scenario of scenarios()) { scenario.run(); console.log(`PASS ${scenario.name}`); }
}
