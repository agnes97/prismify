import {
  scrypt,
  randomBytes,
  timingSafeEqual,
  type BinaryLike,
} from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify<BinaryLike, BinaryLike, number, Buffer>(scrypt)

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex')
  const buffer = await scryptAsync(password, salt, 64)
  return `${buffer.toString('hex')}.${salt}`
}

export async function comparePassword(
  hashedPassword: string,
  password: string,
): Promise<boolean> {
  const [hash, salt] = hashedPassword.split('.')
  if (!hash || !salt) return false

  // Create buffer from hash to pass into the timingSafeEqual
  const hashBuffer = Buffer.from(hash, 'hex')

  // Hash the new supplied password
  const buffer = await scryptAsync(password, salt, 64)

  // Compare the new supplied password with the hashed password
  return timingSafeEqual(hashBuffer, buffer)
}
