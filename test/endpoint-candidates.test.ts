import { describe, it, expect } from 'vitest';
import { buildEndpointCandidates } from '../src/carelink/client.js';

describe('buildEndpointCandidates()', () => {
  it('should put the config-provided URL first, then known versions newest-first, deduplicated', () => {
    expect(
      buildEndpointCandidates('https://clcloud.minimed.eu/connect/carepartner/v6/display/message'),
    ).toEqual([
      'https://clcloud.minimed.eu/connect/carepartner/v6/display/message',
      'https://clcloud.minimed.eu/connect/carepartner/v13/display/message',
      'https://clcloud.minimed.eu/connect/carepartner/v11/display/message',
      'https://clcloud.minimed.eu/connect/carepartner/v5/display/message',
    ]);
  });

  it('should handle a config that already hands out the newest version', () => {
    expect(
      buildEndpointCandidates('https://clcloud.minimed.eu/connect/carepartner/v13/display/message'),
    ).toEqual([
      'https://clcloud.minimed.eu/connect/carepartner/v13/display/message',
      'https://clcloud.minimed.eu/connect/carepartner/v11/display/message',
      'https://clcloud.minimed.eu/connect/carepartner/v6/display/message',
      'https://clcloud.minimed.eu/connect/carepartner/v5/display/message',
    ]);
  });

  it('should generate fallbacks for an unknown future version', () => {
    const candidates = buildEndpointCandidates('https://clcloud.minimed.eu/connect/carepartner/v14/display/message');
    expect(candidates[0]).toBe('https://clcloud.minimed.eu/connect/carepartner/v14/display/message');
    expect(candidates).toHaveLength(5);
  });

  it('should return an unversioned URL as the only candidate', () => {
    expect(buildEndpointCandidates('https://example.com/display/message')).toEqual([
      'https://example.com/display/message',
    ]);
  });
});
