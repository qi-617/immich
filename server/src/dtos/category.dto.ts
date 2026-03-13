import { ApiProperty } from '@nestjs/swagger';

export class AssetCategoryResponseDto {
  @ApiProperty({ type: 'string', format: 'uuid' })
  id!: string;

  @ApiProperty({ type: 'string', format: 'uuid' })
  assetId!: string;

  @ApiProperty({ type: 'string' })
  categoryName!: string;

  @ApiProperty({ type: 'number', format: 'double' })
  confidence!: number;
}

export class CategorySummaryResponseDto {
  @ApiProperty({ type: 'string' })
  categoryName!: string;

  @ApiProperty({ type: 'integer' })
  count!: number;
}
