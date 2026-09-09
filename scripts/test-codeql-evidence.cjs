const assert = require('node:assert/strict');
const { summarizeSarif } = require('./codeql-evidence.cjs');
function scenarios() {
  const physical = { artifactLocation: { uri: 'apps/api/src/example.ts' }, region: { startLine: 12, endLine: 14, snippet: { text: 'DO_NOT_LOG_SNIPPET' } } };
  const report = { runs: [{ tool: { driver: { rules: [{ id: 'js/example', properties: { 'security-severity': '8.1' }, defaultConfiguration: { level: 'warning' } }] } }, results: [{ ruleId: 'js/example', message: { text: 'DO_NOT_LOG_MESSAGE' }, locations: [{ physicalLocation: physical }], codeFlows: [{ threadFlows: [{ locations: [{ location: { physicalLocation: physical, message: { text: 'DO_NOT_LOG_FLOW_MESSAGE' } } }] }] }], fixes: [{ description: { text: 'DO_NOT_LOG_FIX' } }] }] }] };
  // Rule IDs are not globally unique across tool components. Use a driver
  // shadow with a different severity so wrong-component lookup is observable.
  function extensionReport() {
    return { runs: [{
      tool: {
        driver: { rules: [{ id: 'js/example', properties: { 'security-severity': '1.0' } }] },
        extensions: [{ name: 'query-pack', guid: '11111111-1111-4111-8111-111111111111', rules: [{
          id: 'js/example', guid: '22222222-2222-4222-8222-222222222222',
          properties: { 'security-severity': '9.2', privateFixture: 'DO_NOT_LOG_EXTENSION' },
          defaultConfiguration: { level: 'warning' }, help: { text: 'DO_NOT_LOG_HELP' },
        }] }],
      },
      results: [{ ruleId: 'js/example', ruleIndex: 0,
        rule: { id: 'js/example', index: 0, toolComponent: { index: 0 } },
        locations: [{ physicalLocation: physical }],
      }],
    }] };
  }
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
    { name: 'resolves extension rule metadata when the driver has no rules', run() {
      const input = extensionReport();
      input.runs[0].tool.driver.rules = [];
      const [row] = summarizeSarif(input);
      assert.equal(row.securitySeverity, '9.2');
      assert.equal(row.level, 'warning');
      assert.deepEqual(row.locations, [{ path: 'apps/api/src/example.ts', line: 12, endLine: 14 }]);
      assert.doesNotMatch(JSON.stringify(row), /DO_NOT_LOG/);
    } },
    { name: 'an extension rule must not borrow same-ID driver metadata', run() {
      const [row] = summarizeSarif(extensionReport());
      assert.equal(row.securitySeverity, '9.2');
    } },
    { name: 'supports rule.id and rule.index without deprecated result fields', run() {
      const input = extensionReport();
      delete input.runs[0].results[0].ruleId;
      delete input.runs[0].results[0].ruleIndex;
      const [row] = summarizeSarif(input);
      assert.equal(row.rule, 'js/example');
      assert.equal(row.securitySeverity, '9.2');
    } },
    { name: 'supports a driver rule referenced by the rule object', run() {
      const input = extensionReport();
      input.runs[0].results[0] = { rule: { id: 'js/example', index: 0 } };
      assert.equal(summarizeSarif(input)[0].securitySeverity, '1.0');
    } },
    { name: 'supports component and descriptor GUID references', run() {
      const input = extensionReport();
      input.runs[0].results[0] = { rule: {
        id: 'js/example', guid: '22222222-2222-4222-8222-222222222222',
        toolComponent: { guid: '11111111-1111-4111-8111-111111111111' },
      } };
      assert.equal(summarizeSarif(input)[0].securitySeverity, '9.2');
    } },
    { name: 'unresolved explicit component cannot fall back to the driver', run() {
      const input = extensionReport();
      input.runs[0].results[0].rule.toolComponent.index = 7;
      const [row] = summarizeSarif(input);
      assert.equal(row.securitySeverity, null);
      assert.equal(row.rule, 'js/example');
    } },
    { name: 'unresolved explicit rule index cannot fall back to a matching ID', run() {
      const input = extensionReport();
      input.runs[0].results[0].rule.index = 7;
      input.runs[0].results[0].ruleIndex = 7;
      assert.equal(summarizeSarif(input)[0].securitySeverity, null);
    } },
    { name: 'preserves explicit result level with extension security severity', run() {
      const input = extensionReport();
      input.runs[0].results[0].level = 'error';
      const [row] = summarizeSarif(input);
      assert.equal(row.level, 'error');
      assert.equal(row.securitySeverity, '9.2');
    } },
  ];
}
module.exports = { scenarios };
if (require.main === module) {
  for (const scenario of scenarios()) { scenario.run(); console.log(`PASS ${scenario.name}`); }
}
