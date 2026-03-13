import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators';
import { AssetCategoryResponseDto, CategorySummaryResponseDto } from 'src/dtos/category.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import { ApiTag, Permission } from 'src/enum';
import { Auth, Authenticated } from 'src/middleware/auth.guard';
import { ClassificationService } from 'src/services/classification.service';
import { UUIDParamDto } from 'src/validation';

@ApiTags(ApiTag.Search)
@Controller('categories')
export class CategoryController {
  constructor(private service: ClassificationService) {}

  @Get('asset/:id')
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'Get asset categories',
    description: 'Retrieve classification categories for the specified asset.',
    history: new HistoryBuilder().added('v1').beta('v1'),
  })
  getAssetCategories(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<AssetCategoryResponseDto[]> {
    return this.service.getAssetCategories(auth, id);
  }

  @Get()
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'Get category summaries',
    description: 'Retrieve a summary of all categories with asset counts for the current user.',
    history: new HistoryBuilder().added('v1').beta('v1'),
  })
  getCategorySummaries(@Auth() auth: AuthDto): Promise<CategorySummaryResponseDto[]> {
    return this.service.getCategorySummaries(auth);
  }
}
