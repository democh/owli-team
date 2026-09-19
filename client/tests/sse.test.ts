import { describe, expect, it } from 'vitest'
import { extractSseEvents, parseSseBlock } from '../src/lib/sse'

const event = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`

describe('extractSseEvents', () => {
  it('按 \\n\\n 切出完整事件块并保留残余缓冲', () => {
    const buffer = `${event({ type: 'run:start' })}data: {"type":"turn:star`
    const { blocks, rest } = extractSseEvents(buffer)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toContain('run:start')
    expect(rest).toBe('data: {"type":"turn:star')
  })

  it('多个连续事件全部切出', () => {
    const buffer = event({ type: 'a' }) + event({ type: 'b' }) + event({ type: 'c' })
    const { blocks, rest } = extractSseEvents(buffer)
    expect(blocks).toHaveLength(3)
    expect(rest).toBe('')
  })

  it('无完整事件时原样返回', () => {
    const { blocks, rest } = extractSseEvents('data: {"type":"x"}')
    expect(blocks).toHaveLength(0)
    expect(rest).toBe('data: {"type":"x"}')
  })
})

describe('parseSseBlock', () => {
  it('解析 data 行 JSON', () => {
    const parsed = parseSseBlock('data: {"type":"message:delta","messageId":"m1","delta":"你好"}')
    expect(parsed).toEqual({ type: 'message:delta', messageId: 'm1', delta: '你好' })
  })

  it('多行 data 聚合后解析', () => {
    const parsed = parseSseBlock('data: {"type":"run:end",\ndata: "runId":"r1","reason":"completed"}')
    expect(parsed).toEqual({ type: 'run:end', runId: 'r1', reason: 'completed' })
  })

  it('注释（心跳）与非法 JSON 返回 null', () => {
    expect(parseSseBlock(': keep-alive')).toBeNull()
    expect(parseSseBlock('data: not-json')).toBeNull()
    expect(parseSseBlock('event: custom')).toBeNull()
  })
})
