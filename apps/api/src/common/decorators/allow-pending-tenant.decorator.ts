import { SetMetadata } from '@nestjs/common';

export const ALLOW_PENDING_TENANT_KEY = 'allowPendingTenant';
export const AllowPendingTenant = () => SetMetadata(ALLOW_PENDING_TENANT_KEY, true);

