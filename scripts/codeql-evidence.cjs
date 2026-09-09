/* Diagnostic metadata only: never print result messages, code snippets, fixes,
 * artifact contents, environment values or tokens from a SARIF report. */
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');

function summarizeSarif(report) {
  assert.ok(Array.isArray(report?.runs), 'CodeQL SARIF runs are missing');
  const rows = [];
  for (const run of report.runs) {
    const rules = run.tool?.driver?.rules || [];
    function location(entry) {
      const physical = entry?.physicalLocation;
      if (!physical) return null;
      const artifact = physical.artifactLocation;
      const uri = artifact?.uri ?? run.artifacts?.[artifact?.index]?.location?.uri;
      return {
        path: typeof uri === 'string' ? uri : null,
        line: physical.region?.startLine ?? null,
        endLine: physical.region?.endLine ?? null,
      };
    }
    for (const result of run.results || []) {
      const rule = rules.find(entry => entry.id === result.ruleId) ?? rules[result.ruleIndex];
      rows.push({
        rule: result.ruleId ?? rule?.id ?? null,
        securitySeverity: rule?.properties?.['security-severity'] ?? null,
        level: result.level ?? rule?.defaultConfiguration?.level ?? null,
        locations: (result.locations || []).map(location).filter(Boolean),
        flows: (result.codeFlows || []).flatMap(flow => (flow.threadFlows || [])
          .map(thread => (thread.locations || []).map(entry => location(entry.location)).filter(Boolean))),
      });
    }
  }
  return rows;
}
module.exports = { summarizeSarif };
if (require.main === module) {
  const rows = summarizeSarif(JSON.parse(readFileSync('codeql-results/javascript.sarif', 'utf8')));
  console.log(JSON.stringify({ codeqlEvidence: 'metadata-only', findings: rows.length }));
  // JSON framing escapes line breaks; report content cannot become a workflow
  // command. This diagnostic does not dismiss findings or replace either gate.
  for (const row of rows) console.log(JSON.stringify(row));
}
