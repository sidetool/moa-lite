export const syncSchema: Record<string, { key: string[]; fields: string[]; refs?: Record<string, string> }> = {
  profiles: { key: ['id'], fields: ['id', 'name', 'color', 'kids', 'created_at', 'account_id', 'avatar'] },
  settings: { key: ['id'], fields: ['id', 'value'], refs: { id: 'profiles' } },
  media: { key: ['id'], fields: ['id', 'folder_id', 'title', 'type', 'metadata', 'added_at'] },
  episodes: { key: ['id'], fields: ['id', 'media_id', 'season', 'number', 'title', 'duration', 'thumb'], refs: { media_id: 'media' } },
  source_media: { key: ['media_id'], fields: ['media_id', 'source_id', 'url', 'detail_at'], refs: { media_id: 'media' } },
  source_episodes: { key: ['episode_id'], fields: ['episode_id', 'url'], refs: { episode_id: 'episodes' } },
  source_images: { key: ['id'], fields: ['id', 'url', 'headers'] },
  tmdb_links: { key: ['media_id'], fields: ['media_id', 'kind', 'tmdb_id', 'season', 'status', 'score', 'checked_at'], refs: { media_id: 'media' } },
  progress: { key: ['profile_id', 'episode_id'], fields: ['profile_id', 'episode_id', 'position', 'duration', 'completed', 'updated_at'], refs: { profile_id: 'profiles', episode_id: 'episodes' } },
  watchlist: { key: ['profile_id', 'media_id'], fields: ['profile_id', 'media_id', 'added_at'], refs: { profile_id: 'profiles', media_id: 'media' } },
  title_group_overrides: { key: ['profile_id', 'media_id'], fields: ['profile_id', 'media_id', 'group_id'], refs: { profile_id: 'profiles', media_id: 'media' } }
};
export function syncOrder(key: string) { return Object.keys(syncSchema).indexOf(JSON.parse(key)[0]); }
