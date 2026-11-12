export const ONBOARDING_QUEUE = 'onboarding';
export const ONBOARDING_JOB_WELCOME = 'restaurant-welcome';

export interface OnboardingWelcomeJobPayload {
  tenantId: string;
  tenantName: string;
  outletId: string;
  ownerUserId: string;
  ownerEmail: string | null;
}

