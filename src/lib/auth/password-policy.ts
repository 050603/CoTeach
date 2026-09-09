/** Shared by account creation/reset forms and server validation. Login accepts existing passwords. */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 256;
export const PASSWORD_LENGTH_HINT = `密码长度须为 ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} 个字符`;

export function isValidNewPasswordLength(password: string): boolean {
  return password.length >= PASSWORD_MIN_LENGTH && password.length <= PASSWORD_MAX_LENGTH;
}
