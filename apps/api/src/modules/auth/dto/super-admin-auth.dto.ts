import { IsEmail, IsOptional, IsString, Length, Matches } from 'class-validator';

const STRONG_PASSWORD_REGEX = /^(?=.*[A-Za-z])(?=.*[\d@$!%*?&#^()_\-+=]).{8,72}$/;

export class SuperAdminSetupDto {
  @IsString()
  @Length(2, 100)
  name!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @Matches(/^\+?[1-9]\d{9,14}$/, {
    message: 'Enter a valid 10 to 15 digit phone number (e.g. +919999999999)',
  })
  phone!: string;

  @IsString()
  @Matches(STRONG_PASSWORD_REGEX, {
    message: 'Password must be 8-72 characters and include letters and numbers or symbols.',
  })
  password!: string;

  @IsOptional()
  @IsString()
  @Length(4, 128)
  setupToken?: string;
}

export class ForgotPasswordDto {
  @IsString()
  @Length(4, 160)
  identifier!: string;
}

export class ResetPasswordDto {
  @IsString()
  @Length(12, 256)
  token!: string;

  @IsString()
  @Matches(STRONG_PASSWORD_REGEX, {
    message: 'Password must be 8-72 characters and include letters and numbers or symbols.',
  })
  newPassword!: string;
}

export class ChangePasswordDto {
  @IsString()
  @Length(6, 72)
  currentPassword!: string;

  @IsString()
  @Matches(STRONG_PASSWORD_REGEX, {
    message: 'New password must be 8-72 characters and include letters and numbers or symbols.',
  })
  newPassword!: string;
}

