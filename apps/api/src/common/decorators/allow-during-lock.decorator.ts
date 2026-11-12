import { SetMetadata } from '@nestjs/common';

export const ALLOW_DURING_LOCK_KEY = 'allowDuringLockOrSettlement';

/**
 * Allows operational routes required to finish in-progress dining sessions,
 * fulfill open KOT tickets, consolidate/settle bills, record payments,
 * download receipts, or manage billing/support while a tenant is LOCKED
 * (subscription read-only) or draining active tables before suspension.
 */
export const AllowDuringLockOrSettlement = () => SetMetadata(ALLOW_DURING_LOCK_KEY, true);

