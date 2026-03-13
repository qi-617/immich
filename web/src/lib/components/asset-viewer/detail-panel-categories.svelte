<script lang="ts">
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { getAssetCategories, type AssetCategoryResponseDto, type AssetResponseDto } from '@immich/sdk';
  import { Badge, Link, Text } from '@immich/ui';
  import { t } from 'svelte-i18n';

  interface Props {
    asset: AssetResponseDto;
  }

  let { asset }: Props = $props();

  let categories = $state<AssetCategoryResponseDto[]>([]);

  $effect(() => {
    const assetId = asset.id;
    let cancelled = false;

    getAssetCategories({ id: assetId })
      .then((result) => {
        if (!cancelled) {
          categories = result;
        }
      })
      .catch(() => {
        if (!cancelled) {
          categories = [];
        }
      });

    return () => {
      cancelled = true;
    };
  });
</script>

{#if !authManager.isSharedLink && categories.length > 0}
  <section class="relative px-2 pb-12 dark:bg-immich-dark-bg dark:text-immich-dark-fg">
    <div class="px-2 mt-4">
      <div class="flex h-10 w-full items-center justify-between text-sm">
        <Text color="muted">{$t('categories')}</Text>
      </div>
      <div class="flex flex-wrap pt-2 gap-1" data-testid="detail-panel-categories">
        {#each categories as cat (cat.id)}
          <Badge size="small" shape="round">
            <Link
              href={Route.search({ query: cat.categoryName })}
              class="text-light no-underline rounded-full hover:bg-primary-400 px-2"
            >
              {cat.categoryName}
              <span class="text-xs opacity-60">{Math.round(cat.confidence * 100)}%</span>
            </Link>
          </Badge>
        {/each}
      </div>
    </div>
  </section>
{/if}
