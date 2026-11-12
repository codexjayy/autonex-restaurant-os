import { SetMetadata } from '@nestjs/common';
import type { Permission } from '@autonex/permissions';

export const PERMISSIONS_KEY = 'autonex:permissions';

export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

