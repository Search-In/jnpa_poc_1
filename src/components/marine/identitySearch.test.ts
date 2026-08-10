import { describe, expect, it } from 'vitest';
import { SEARCHABLE_IDENTIFIERS, matchesIdentity, searchHint } from '@/components/marine/identitySearch';

describe('matchesIdentity', () => {
  it('matches any one of the supplied fields', () => {
    const fields = ['HONG YONG CHANG SHENG', 'INNSA1NS0S0814', 'S0814', '1103316'];
    expect(matchesIdentity('hong yong', fields)).toBe(true);
    expect(matchesIdentity('S0814', fields)).toBe(true);
    expect(matchesIdentity('1103316', fields)).toBe(true);
    expect(matchesIdentity('INNSA1NS0S0814', fields)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(matchesIdentity('s0814', ['S0814'])).toBe(true);
    expect(matchesIdentity('S0814', ['s0814'])).toBe(true);
  });

  it('ignores spaces on both sides, so "jp91" finds "JP 91"', () => {
    expect(matchesIdentity('jp91', ['JP 91'])).toBe(true);
    expect(matchesIdentity('JP 91', ['JP91'])).toBe(true);
  });

  it('finds a VCN by its VIA tail — the VIA is embedded in the VCN', () => {
    expect(matchesIdentity('S0814', ['INNSA1NS0S0814'])).toBe(true);
  });

  it('treats an empty needle as no filter', () => {
    expect(matchesIdentity('', ['anything'])).toBe(true);
    expect(matchesIdentity('   ', [])).toBe(true);
  });

  it('never matches on absent fields', () => {
    expect(matchesIdentity('x', [null, undefined, '', '   '])).toBe(false);
  });

  it('accepts numeric fields such as call_id', () => {
    expect(matchesIdentity('51', [51])).toBe(true);
  });

  it('does not fuzzy-match — a hit is always literal containment', () => {
    expect(matchesIdentity('S0815', ['S0814'])).toBe(false);
    expect(matchesIdentity('HONGYONGX', ['HONG YONG'])).toBe(false);
  });
});

describe('SEARCHABLE_IDENTIFIERS', () => {
  it('records voyage, rotation and IGM as unavailable', () => {
    const missing = SEARCHABLE_IDENTIFIERS.filter((i) => !i.available).map((i) => i.label);
    expect(missing).toEqual(['Voyage No', 'Rotation No', 'IGM No']);
  });

  it('hints only the identifiers that are actually searchable', () => {
    const hint = searchHint();
    expect(hint).toContain('VIA');
    expect(hint).toContain('IMO');
    expect(hint).not.toContain('IGM');
    expect(hint).not.toContain('Rotation');
  });
});
