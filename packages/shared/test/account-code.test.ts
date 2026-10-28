import { describe, expect, it } from 'vitest';
import {
  isShortenableAccountCode,
  shortenAccountCode,
  SHORT_UUID_LENGTH,
} from '../src/account-code.js';

const UUID = '9babd67a-3607-4505-b42b-b02a6d0eead3';

describe('shortenAccountCode', () => {
  it('keeps a code without a uuid untouched', () => {
    expect(shortenAccountCode('asset:gateway_cash')).toBe('asset:gateway_cash');
    expect(shortenAccountCode('revenue:platform_fee')).toBe(
      'revenue:platform_fee',
    );
  });

  it('keeps the meaningful parts and shortens the uuid', () => {
    expect(shortenAccountCode(`liability:user:${UUID}:available`)).toBe(
      'liability:user:9babd67a…:available',
    );
    expect(shortenAccountCode(`liability:user:${UUID}:pending`)).toBe(
      'liability:user:9babd67a…:pending',
    );
  });

  it('shortens the uuid at any position in the code', () => {
    expect(shortenAccountCode(`user:${UUID}:pending`)).toBe(
      'user:9babd67a…:pending',
    );
  });

  it('shortens every uuid when there is more than one', () => {
    const other = 'cb276d2c-441a-4e97-abf2-e322373e85c7';
    expect(shortenAccountCode(`user:${UUID}:user:${other}`)).toBe(
      'user:9babd67a…:user:cb276d2c…',
    );
  });

  it('is idempotent: shortening twice changes nothing', () => {
    const once = shortenAccountCode(`liability:user:${UUID}:available`);
    expect(shortenAccountCode(once)).toBe(once);
  });

  it('keeps the first SHORT_UUID_LENGTH characters of the uuid', () => {
    const short = shortenAccountCode(`liability:user:${UUID}:available`);
    expect(short).toContain(UUID.slice(0, SHORT_UUID_LENGTH));
    expect(short).not.toContain(UUID.slice(SHORT_UUID_LENGTH));
  });

  it('does not shorten a uuid-like string that is not a full uuid', () => {
    // A truncated code (e.g. one that was already shortened elsewhere)
    // must not be mangled further.
    expect(shortenAccountCode('liability:user:9babd67a…:available')).toBe(
      'liability:user:9babd67a…:available',
    );
  });
});

describe('isShortenableAccountCode', () => {
  it('is true only when the code carries a uuid', () => {
    expect(isShortenableAccountCode(`liability:user:${UUID}:available`)).toBe(
      true,
    );
    expect(isShortenableAccountCode('asset:gateway_cash')).toBe(false);
  });
});
