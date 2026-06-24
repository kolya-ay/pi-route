// src/admin/errors.ts

export type AdminErrorCode = 'account_not_found' | 'method_not_allowed'

export class AdminError extends Error {
  constructor(
    public code: AdminErrorCode,
    message: string,
    public detail?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'AdminError'
  }
}
