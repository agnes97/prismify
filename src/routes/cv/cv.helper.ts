type Experience = {
  company_name: string
  employment_start: string
  employment_end: string | null
}

export type CV = {
  name: string
  date_of_birth: string
  phone_number: string
  email: string
  address_street: string
  address_city: string
  address_zip: string
  experiences: Experience[]
}

const STAR_SYMBOL = '✶'

function replaceByStars(string: string) {
  return string.replace(/[^ .@]/g, STAR_SYMBOL)
}

function maskPhoneNumber(phoneNumber: string) {
  return phoneNumber
    .split(' ')
    .map((part, index) => (index === 0 ? part : replaceByStars(part)))
    .join(' ')
}

export function maskData(cv?: CV) {
  if (!cv) return cv

  const { name, phone_number, experiences, ...rest } = cv

  return {
    name,
    phone_number: maskPhoneNumber(phone_number),
    ...Object.fromEntries(
      Object.entries(rest).map(([key, value]) => [key, replaceByStars(value)]),
    ),
    experiences,
  }
}
