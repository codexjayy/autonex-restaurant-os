import { SetMetadata } from '@nestjs/common';
import type { ActorRole } from '@autonex/shared';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: ActorRole[]) => SetMetadata(ROLES_KEY, roles);

