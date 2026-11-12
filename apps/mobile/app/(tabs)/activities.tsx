import { SPORT_TYPES, type SportType } from '@pace/domain';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { useMemo, useState } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, SectionList, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ActivityRow } from '@/components/ActivityRow';
import { Input } from '@/components/Input';
import { Text } from '@/components/Text';
import { Chip, EmptyState, ErrorState, LoadingState } from '@/components/layout';
import { groupByMonth } from '@/features/activity-view';
import { sportIcon, sportLabel } from '@/features/display';
import { useActivityList, useInvalidateAll } from '@/hooks/queries';
import { deviceTimeZone, getServices } from '@/services/container';
import { useUnits } from '@/stores/preferences';
import { useTheme } from '@/theme/ThemeProvider';

type Range = 'all' | 'week' | 'month' | 'year';

function rangeStart(r: Range, now = new Date()): number | undefined {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  if (r === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  else if (r === 'month') d.setDate(1);
  else if (r === 'year') d.setMonth(0, 1);
  else return undefined;
  return d.getTime();
}

export default function Activities() {
  const units = useUnits();
  const { colors, spacing } = useTheme();
  const invalidate = useInvalidateAll();
  const [search, setSearch] = useState('');
  const [sport, setSport] = useState<SportType | null>(null);
  const [range, setRange] = useState<Range>('all');
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest');
  const [importing, setImporting] = useState(false);

  const query = useMemo(
    () => ({
      search: search.trim() || undefined,
      sportTypes: sport ? [sport] : undefined,
      from: rangeStart(range),
      sort,
    }),
    [search, sport, range, sort],
  );
  const q = useActivityList(query);
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const total = q.data?.pages[0]?.total ?? 0;
  const sections = useMemo(() => groupByMonth(items, deviceTimeZone()), [items]);

  const importFile = async (fileUri: string, sportOverride?: SportType): Promise<void> => {
    setImporting(true);
    try {
      const xml = await new File(fileUri).text();
      const { activityService } = await getServices();
      const r = await activityService.importGpx(xml, {
        timezone: deviceTimeZone(),
        ...(sportOverride ? { sportType: sportOverride } : {}),
      });
      await invalidate();
      Alert.alert(
        'Activity imported',
        r.warnings.join('\n') || 'The GPX track was added to your history.',
      );
    } catch (e) {
      if ((e as { code?: string }).code === 'sport_required' && !sportOverride) {
        Alert.alert('Which sport?', 'This file does not say which sport it is.', [
          ...(['running', 'cycling', 'walking', 'hiking'] as const).map((s) => ({
            text: sportLabel(s),
            onPress: () => void importFile(fileUri, s),
          })),
          { text: 'Cancel', style: 'cancel' as const },
        ]);
      } else {
        Alert.alert('Import failed', e instanceof Error ? e.message : String(e));
      }
    } finally {
      setImporting(false);
    }
  };

  const importGpx = async (): Promise<void> => {
    const pick = await DocumentPicker.getDocumentAsync({
      type: ['application/gpx+xml', 'application/xml', 'text/xml', '*/*'],
      copyToCacheDirectory: true,
    });
    if (pick.canceled || !pick.assets[0]) return;
    await importFile(pick.assets[0].uri);
  };

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.lg }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: spacing.md,
          }}
        >
          <Text variant="title" accessibilityRole="header">
            Activities
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Import GPX file"
            onPress={() => void importGpx()}
            disabled={importing}
            hitSlop={12}
          >
            <Text variant="label" color="accent">
              {importing ? 'Importing…' : 'Import GPX'}
            </Text>
          </Pressable>
        </View>
        <Input
          label="Search"
          value={search}
          onChangeText={setSearch}
          placeholder="Title or notes"
          returnKeyType="search"
          clearButtonMode="while-editing"
        />
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: spacing.sm, paddingBottom: spacing.sm }}
        >
          <Chip label="All sports" selected={sport === null} onPress={() => setSport(null)} />
          {SPORT_TYPES.map((s) => (
            <Chip
              key={s}
              label={sportLabel(s)}
              icon={sportIcon(s) as never}
              selected={sport === s}
              onPress={() => setSport(sport === s ? null : s)}
            />
          ))}
        </ScrollView>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: spacing.sm, paddingBottom: spacing.md }}
        >
          {(['all', 'week', 'month', 'year'] as const).map((r) => (
            <Chip
              key={r}
              label={
                { all: 'Any time', week: 'This week', month: 'This month', year: 'This year' }[r]
              }
              selected={range === r}
              onPress={() => setRange(r)}
            />
          ))}
          <Chip
            label={sort === 'newest' ? 'Newest first' : 'Oldest first'}
            selected={false}
            onPress={() => setSort(sort === 'newest' ? 'oldest' : 'newest')}
          />
        </ScrollView>
      </View>
      {q.isLoading ? (
        <LoadingState />
      ) : q.error ? (
        <ErrorState message="Could not load activities." onRetry={() => void q.refetch()} />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(a) => a.id}
          renderItem={({ item }) => <ActivityRow activity={item} units={units} />}
          renderSectionHeader={({ section }) => (
            <View
              style={{
                backgroundColor: colors.background,
                paddingTop: spacing.md,
                paddingBottom: spacing.sm,
              }}
            >
              <Text variant="label" color="secondary" accessibilityRole="header">
                {section.title.toUpperCase()}
              </Text>
            </View>
          )}
          stickySectionHeadersEnabled
          contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.xxxl }}
          onEndReached={() => {
            if (q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
          }}
          onEndReachedThreshold={0.5}
          refreshControl={
            <RefreshControl refreshing={q.isRefetching} onRefresh={() => void q.refetch()} />
          }
          ListHeaderComponent={
            total > 0 ? (
              <Text variant="caption" color="secondary" style={{ marginBottom: spacing.sm }}>
                {total} {total === 1 ? 'activity' : 'activities'}
              </Text>
            ) : undefined
          }
          ListEmptyComponent={
            <EmptyState
              icon="search-outline"
              title={
                search || sport || range !== 'all' ? 'No matching activities' : 'No activities yet'
              }
              message={
                search || sport || range !== 'all'
                  ? 'Try different filters.'
                  : 'Recorded and imported activities appear here.'
              }
            />
          }
          ListFooterComponent={
            q.isFetchingNextPage ? <LoadingState label="Loading more…" /> : undefined
          }
        />
      )}
    </SafeAreaView>
  );
}
