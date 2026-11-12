import { IsBoolean } from 'class-validator';

export class StockToggleDto {
  @IsBoolean()
  inStock!: boolean;
}

