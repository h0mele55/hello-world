/**
 * Load test for /verify (#69): k6, 50 requests a second for five minutes,
 * against a staging deploy of the app.
 *
 *   k6 run -e BASE_URL=https://staging.example tests/load/verify.js
 *
 * /verify decides in the visitor's browser (rule 5): the server only renders
 * the page, with a fresh CSP nonce each time, and serves static files. So
 * this asks for the page itself, as a first visit does, and checks that each
 * answer is the verifier with its CSP. The thresholds fail the run when more
 * than 1% of requests fail or the 95th percentile passes 500 ms; record both
 * figures in the pull request that runs it. Not run in CI: it needs a deploy
 * and k6 (https://grafana.com/docs/k6/).
 */
import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:3100';

export const options = {
  scenarios: {
    verify: {
      executor: 'constant-arrival-rate',
      rate: 50,
      timeUnit: '1s',
      duration: '5m',
      preAllocatedVUs: 50,
      maxVUs: 200,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
    checks: ['rate>0.99'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export default function visitVerify() {
  const res = http.get(`${BASE_URL}/verify`, { headers: { 'Accept-Language': 'en' }, tags: { page: 'verify' } });
  check(res, {
    'status 200': (r) => r.status === 200,
    // Rendered by the server only when the deploy names its registry and endpoints.
    'is the configured verifier': (r) => typeof r.body === 'string' && r.body.includes('data-testid="verify-registry"'),
    'carries its CSP': (r) => /script-src 'self' 'nonce-/.test(r.headers['Content-Security-Policy'] || ''),
  });
}
