import { useState, useCallback } from 'react';
import { api, errorMessage } from '../api.ts';
import { Card, Btn, SectionHeader, Badge } from '../components/Card.tsx';

const SCENARIOS = [
  { id: 'valid_payment', label: 'Valid payment', desc: 'Complete payment within all policy limits' },
  { id: 'exceed_per_transaction_limit', label: 'Per-transaction limit', desc: 'Amount exceeds max_amount_minor' },
  { id: 'exhaust_budget', label: 'Budget exhaustion', desc: 'Sequential payments drain daily budget' },
  { id: 'unauthorized_payee', label: 'Unauthorized payee', desc: 'Payee is not in the allowed list' },
  { id: 'expired_intent', label: 'Expired intent', desc: 'TTL expired before execution' },
  { id: 'replay_attack', label: 'Replay attack', desc: 'Re-execute an already-succeeded intent' },
  { id: 'tampered_payload', label: 'Tampered payload', desc: 'Amount modified after signing' },
  { id: 'budget_race', label: 'Concurrent budget requests', desc: 'Three $40 requests against a $100 budget' },
  { id: 'malicious_ai_output', label: 'Policy override attempt', desc: 'AI output attempts to override budget' },
  { id: 'provider_timeout', label: 'Provider timeout', desc: 'Ambiguous outcome; budget is preserved' },
  { id: 'tampered_audit', label: 'Tampered audit record', desc: 'Modify audit event metadata' },
  { id: 'malformed_ai_output', label: 'Malformed AI output', desc: 'Validate invalid schema formats' },
];

export default function SecurityLab() {
  type ScenarioResult = Awaited<ReturnType<typeof api.runLabScenario>> | { error: string; passed: false };
  const [results, setResults] = useState<Record<string, ScenarioResult>>({});
  const [running, setRunning] = useState<string | null>(null);

  const run = useCallback(async (scenarioId: string) => {
    setRunning(scenarioId);
    try {
      const result = await api.runLabScenario(scenarioId);
      setResults(r => ({ ...r, [scenarioId]: result }));
    } catch (error: unknown) {
      setResults(r => ({ ...r, [scenarioId]: { error: errorMessage(error), passed: false } }));
    } finally {
      setRunning(null);
    }
  }, []);

  async function runAll() {
    for (const s of SCENARIOS) {
      await run(s.id);
    }
  }

  const passCount = Object.values(results).filter(r => r.passed).length;
  const totalRan = Object.keys(results).length;

  return (
    <div>
      <SectionHeader title="Security lab" sub="Exercise policy and transaction controls with the simulated provider." />

      <div style={{ display: 'flex', gap: 12, marginBottom: 24, alignItems: 'center' }}>
        <Btn onClick={runAll} disabled={running !== null}>Run all scenarios</Btn>
        {totalRan > 0 && (
          <span style={{ fontSize: 13, color: passCount === totalRan ? 'var(--green)' : 'var(--yellow)' }}>
            {passCount}/{totalRan} passed
          </span>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {SCENARIOS.map(s => {
          const result = results[s.id];
          const isRunning = running === s.id;

          return (
            <Card key={s.id} style={{ borderLeft: `3px solid ${result ? (result.passed ? 'var(--green)' : 'var(--red)') : 'var(--border)'}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: result ? 12 : 0 }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>{s.label}</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>{s.desc}</div>
                </div>
                <Btn
                  onClick={() => run(s.id)}
                  disabled={isRunning}
                  variant={result?.passed === false ? 'danger' : 'primary'}
                  style={{ fontSize: 12, padding: '6px 14px', flexShrink: 0 }}
                >
                  {isRunning ? 'Running…' : result ? 'Run again' : 'Run scenario'}
                </Btn>
              </div>

              {result && !('error' in result) && (
                <div style={{ fontSize: 12 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
                    <div>
                      <span style={{ color: 'var(--muted)' }}>Policy: </span>{result.policy_summary}
                    </div>
                    <div>
                      <span style={{ color: 'var(--muted)' }}>Input: </span>{result.input_summary}
                    </div>
                    <div>
                      <span style={{ color: 'var(--muted)' }}>Expected: </span>
                      <span style={{ color: 'var(--text)' }}>{result.expected_result}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span style={{ color: 'var(--muted)' }}>Actual: </span>
                      <span style={{ color: result.passed ? 'var(--green)' : 'var(--red)', fontWeight: 700 }}>{result.actual_result}</span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' as const }}>
                    <Badge
                      label={result.passed ? 'PASSED' : 'FAILED'}
                      color={result.passed ? 'green' : 'red'}
                    />
                    <Badge
                      label={result.provider_invoked ? `Provider invoked (${result.provider_mode})` : 'Provider NOT invoked'}
                      color={result.provider_invoked ? 'blue' : 'gray'}
                    />
                  </div>
                  {result.details && Object.keys(result.details).length > 0 && (
                    <details style={{ marginTop: 8 }}>
                      <summary style={{ cursor: 'pointer', color: 'var(--muted)', fontSize: 11 }}>Show details</summary>
                      <pre style={{ marginTop: 8, fontSize: 10, color: 'var(--muted)', background: 'var(--bg)', padding: 8, borderRadius: 6, overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                        {JSON.stringify(result.details, null, 2).slice(0, 1000)}
                      </pre>
                    </details>
                  )}
                </div>
              )}
              {result && 'error' in result && (
                <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 8 }}>Error: {result.error}</div>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
