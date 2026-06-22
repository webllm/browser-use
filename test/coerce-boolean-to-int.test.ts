import { describe, expect, it } from 'vitest';
import {
  ClickElementActionSchema,
  DropdownOptionsActionSchema,
  InputTextActionSchema,
  ScrollActionSchema,
  SelectDropdownActionSchema,
  UploadFileActionSchema,
  lenientInt,
  lenientNumber,
} from '../src/controller/views.js';

describe('lenientInt helper (pydantic-parity boolean->int coercion)', () => {
  it('coerces true to 1', () => {
    const result = lenientInt().safeParse(true);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(1);
  });

  it('coerces false to 0', () => {
    const result = lenientInt().safeParse(false);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(0);
  });

  it('passes through plain integers', () => {
    const result = lenientInt().safeParse(5);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(5);
  });

  it('does not coerce strings (matches pydantic strict-string behavior)', () => {
    const result = lenientInt().safeParse('5');
    expect(result.success).toBe(false);
  });

  it('rejects non-integer numbers', () => {
    const result = lenientInt().safeParse(3.14);
    expect(result.success).toBe(false);
  });

  it('passes false (=>0) when min=0', () => {
    const result = lenientInt(0).safeParse(false);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(0);
  });

  it('rejects false (=>0) when min=1', () => {
    const result = lenientInt(1).safeParse(false);
    expect(result.success).toBe(false);
  });

  it('accepts true (=>1) when min=1', () => {
    const result = lenientInt(1).safeParse(true);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(1);
  });
});

describe('lenientNumber helper (pydantic-parity boolean->number coercion)', () => {
  it('coerces true to 1', () => {
    const result = lenientNumber().safeParse(true);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(1);
  });

  it('coerces false to 0', () => {
    const result = lenientNumber().safeParse(false);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(0);
  });

  it('passes through floats', () => {
    const result = lenientNumber().safeParse(2.5);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(2.5);
  });
});

describe('InputTextActionSchema lenient index coercion', () => {
  it('accepts {index: true, text: "x"} as {index: 1, text: "x"}', () => {
    const result = InputTextActionSchema.safeParse({ index: true, text: 'x' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.index).toBe(1);
      expect(result.data.text).toBe('x');
    }
  });

  it('accepts {index: false, text: "x"} as {index: 0, text: "x"}', () => {
    const result = InputTextActionSchema.safeParse({ index: false, text: 'x' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.index).toBe(0);
      expect(result.data.text).toBe('x');
    }
  });

  it('accepts plain integer indices', () => {
    const result = InputTextActionSchema.safeParse({ index: 5, text: 'x' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.index).toBe(5);
  });
});

describe('ClickElementActionSchema lenient index coercion', () => {
  it('accepts {index: true} as {index: 1}', () => {
    const result = ClickElementActionSchema.safeParse({ index: true });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.index).toBe(1);
  });

  it('rejects {index: false} because min=1', () => {
    const result = ClickElementActionSchema.safeParse({ index: false });
    expect(result.success).toBe(false);
  });
});

describe('UploadFileActionSchema lenient index coercion', () => {
  it('accepts {index: true, path: "/tmp/x"} as {index: 1, ...}', () => {
    const result = UploadFileActionSchema.safeParse({
      index: true,
      path: '/tmp/x',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.index).toBe(1);
  });
});

describe('DropdownOptionsActionSchema lenient index coercion', () => {
  it('accepts {index: true} as {index: 1}', () => {
    const result = DropdownOptionsActionSchema.safeParse({ index: true });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.index).toBe(1);
  });

  it('rejects {index: false} because min=1', () => {
    const result = DropdownOptionsActionSchema.safeParse({ index: false });
    expect(result.success).toBe(false);
  });
});

describe('SelectDropdownActionSchema lenient index coercion', () => {
  it('accepts {index: true, text: "opt"} as {index: 1, ...}', () => {
    const result = SelectDropdownActionSchema.safeParse({
      index: true,
      text: 'opt',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.index).toBe(1);
  });
});

describe('ScrollActionSchema lenient num_pages/pages/index coercion', () => {
  it('accepts {num_pages: true} as {num_pages: 1}', () => {
    const result = ScrollActionSchema.safeParse({ num_pages: true });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.num_pages).toBe(1);
  });

  it('accepts {pages: false} as {pages: 0}', () => {
    const result = ScrollActionSchema.safeParse({ pages: false });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.pages).toBe(0);
  });

  it('accepts {index: true} as {index: 1}', () => {
    const result = ScrollActionSchema.safeParse({ index: true });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.index).toBe(1);
  });
});
