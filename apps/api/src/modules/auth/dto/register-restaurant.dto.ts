import {
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

export class RegisterRestaurantDto {
  @IsString()
  @Length(2, 120)
  restaurantName!: string;

  @IsString()
  @Length(2, 120)
  outletName!: string;

  @IsString()
  @Length(2, 100)
  ownerName!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @Matches(/^\+?[1-9]\d{9,14}$/, { message: 'phone must be a valid E.164 or 10-15 digit phone number' })
  phone!: string;

  @IsString()
  @Length(8, 72)
  password!: string;

  @IsString()
  @Matches(/^\d{4,6}$/, { message: 'pin must be 4 to 6 digits' })
  pin!: string;

  @IsOptional()
  @IsString()
  @Length(5, 300)
  address?: string;

  @IsOptional()
  @IsUrl()
  logoUrl?: string;

  @IsOptional()
  @IsString()
  @Length(3, 60)
  timezone?: string;

  @IsOptional()
  @IsString()
  @Length(10, 20)
  gstin?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2800)
  gstRateBps?: number;

  @IsOptional()
  @IsString()
  @Length(3, 10)
  currency?: string;

  @IsOptional()
  @IsString()
  @Length(2, 20)
  locale?: string;
}

