/**
 * Configuration, and the one piece of arithmetic in it.
 *
 * `storageHostFor` is worth a test because getting it wrong is silent: the
 * project host accepts the same TUS protocol, so a wrong derivation produces
 * an upload that works and is slower, which nobody would ever investigate. The
 * guard has to be narrow enough that a custom domain or a self-hosted instance
 * falls through to the project URL rather than being rewritten into a hostname
 * that does not exist.
 */

import { describe, expect, it } from 'vitest';
import { CAPTURE_BUCKET, isConfigured, storageHostFor } from './config.js';

describe('storageHostFor', () => {
  it('derives the direct storage host from a standard project URL', () => {
    expect(storageHostFor('https://tnlcuptfldwxtxajudoq.supabase.co'))
      .toBe('https://tnlcuptfldwxtxajudoq.storage.supabase.co');
    expect(storageHostFor('https://tnlcuptfldwxtxajudoq.supabase.co/'))
      .toBe('https://tnlcuptfldwxtxajudoq.storage.supabase.co');
  });

  it('leaves a custom domain alone rather than inventing a hostname', () => {
    expect(storageHostFor('https://api.agency.co.uk')).toBeNull();
    expect(storageHostFor('http://127.0.0.1:54321')).toBeNull();
    expect(storageHostFor('https://tnlcuptfldwxtxajudoq.supabase.co/rest/v1')).toBeNull();
  });
});

describe('isConfigured', () => {
  it('refuses a half-configured project rather than running on part of one', () => {
    expect(isConfigured({ supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: null, uploadEndpoint: 'u' }))
      .toBe(false);
    expect(isConfigured({ supabaseUrl: null, supabaseAnonKey: 'k', uploadEndpoint: 'u' })).toBe(false);
    expect(isConfigured({ supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'k', uploadEndpoint: null }))
      .toBe(false);
    expect(isConfigured({ supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'k', uploadEndpoint: 'u' }))
      .toBe(true);
  });
});

describe('CAPTURE_BUCKET', () => {
  it('is the bucket the storage policy is written against', () => {
    expect(CAPTURE_BUCKET).toBe('wv-captures');
  });
});
