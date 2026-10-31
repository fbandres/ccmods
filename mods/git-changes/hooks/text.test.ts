import { expect, test } from 'claude-code/testing'

import { sliceTo, widthOf } from './text'

test('widthOf: CJK and emoji take two columns, combining marks none', () => {
  expect(widthOf('abc')).toBe(3)
  expect(widthOf('日本語')).toBe(6)
  expect(widthOf('한글')).toBe(4)
  expect(widthOf('🐛 bug')).toBe(6)
  expect(widthOf('❤️')).toBe(2) // a text heart asked to draw as emoji
  expect(widthOf('é')).toBe(1)
  expect(widthOf('ｆｕｌｌ')).toBe(8)
})

test('sliceTo: the longest start that fits, never half a wide character', () => {
  expect(sliceTo('abcdef', 3)).toBe('abc')
  expect(sliceTo('日本語', 3)).toBe('日')
  expect(sliceTo('日本語', 4)).toBe('日本')
  expect(sliceTo('a🐛b', 2)).toBe('a')
  expect(sliceTo('éx', 1)).toBe('é')
})
