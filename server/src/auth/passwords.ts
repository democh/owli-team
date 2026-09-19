/**
 * 密码哈希（M57 多用户 P1）：scrypt（Node 内置，零原生依赖）+ 恒定时间比较。
 *
 * 存储格式：`scrypt$N$r$p$<salt-b64url>$<key-b64url>`（参数入库，便于后续提升强度时平滑升级）。
 * 默认参数 N=2^15（32768）/ r=8 / p=1 / 48 字节随机盐 / 64 字节派生密钥。
 */
import crypto from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(crypto.scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>

const SCRYPT_N = 2 ** 15
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LEN = 64
const SALT_LEN = 48
/** scrypt 内存上限（N=2^15 时约 32MB；留足余量防参数提升后报错） */
const MAX_MEM = 128 * 1024 * 1024

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_LEN)
  const key = await scrypt(password, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: MAX_MEM,
  })
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${key.toString('base64url')}`
}

/** 校验密码（格式非法 / 参数异常一律 false，不抛出） */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [scheme, nRaw, rRaw, pRaw, saltRaw, keyRaw] = stored.split('$')
    if (scheme !== 'scrypt' || !saltRaw || !keyRaw) return false
    const N = Number(nRaw)
    const r = Number(rRaw)
    const p = Number(pRaw)
    if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false
    const salt = Buffer.from(saltRaw, 'base64url')
    const expected = Buffer.from(keyRaw, 'base64url')
    const actual = await scrypt(password, salt, expected.length, { N, r, p, maxmem: MAX_MEM })
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

/**
 * 密码策略（团队部署基线）：≥10 位且至少含两类字符（小写 / 大写 / 数字 / 符号）。
 * 返回中文错误（undefined = 通过）。
 */
export function passwordPolicyError(password: string): string | undefined {
  if (password.length < 10) return '密码至少 10 位'
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(password)).length
  if (classes < 2) return '密码需至少包含两类字符（小写 / 大写 / 数字 / 符号）'
  return undefined
}

/**
 * 生成管理员下发的初始密码（满足策略：3 组随机 + 符号 + 数字，长度 16）。
 * 均无易混淆字符（0/O/1/l/I）。
 */
export function generateInitialPassword(): string {
  const lower = 'abcdefghjkmnpqrstuvwxyz'
  const upper = 'ABCDEFGHJKMNPQRSTUVWXYZ'
  const digits = '23456789'
  const symbols = '!@#$%^&*'
  const pick = (set: string, n: number): string =>
    Array.from({ length: n }, () => set[crypto.randomInt(set.length)]).join('')
  return `${pick(lower, 5)}${pick(upper, 4)}${pick(digits, 4)}${pick(symbols, 2)}${pick(lower, 1)}`
}
