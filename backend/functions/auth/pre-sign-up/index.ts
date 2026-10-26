import type { PreSignUpTriggerHandler } from 'aws-lambda';

// OTP verification happens in the CUSTOM_AUTH challenge flow, which already
// proves ownership of the email address, so sign-up can be auto-confirmed
// here without Cognito's own confirmation-code step.
export const handler: PreSignUpTriggerHandler = async (event) => {
  event.response.autoConfirmUser = true;
  event.response.autoVerifyEmail = true;
  return event;
};
