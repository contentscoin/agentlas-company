/**
 * 상시 기동 위임 (R12.6)
 *
 * 자체 supervisor 를 만들지 않는다. 이유가 실무적이다.
 * 프로세스를 감시하는 프로세스는 그 자신이 죽으면 아무도 감시하지 않는다.
 * OS 는 부팅부터 살아 있고 그 일을 위해 만들어졌다.
 *
 * 이 모듈은 **명령문을 출력만** 한다. 실제 등록은 오너가 실행한다.
 * 시스템 스케줄러에 항목을 심는 것은 되돌리기 어려운 조작이라
 * 코드가 조용히 해서는 안 된다.
 *
 * 업스트림은 systemd/launchd 만 지원해 Windows 자동시작 경로가 없었다.
 * 우리 운영 대상이 상시 Windows 미니PC 이므로 schtasks 를 1순위로 둔다.
 */

export type Platform = 'windows' | 'macos' | 'linux';

export interface ScheduleSpec {
  /** 작업 이름. */
  name: string;
  /** `company run <recipe>` 같은 실행 명령. */
  command: string;
  /** 실행 사용자. Windows 는 svc-broker 같은 서비스 계정을 쓴다. */
  user?: string;
  /** 요일. 없으면 매일. */
  weekday?: 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT' | 'SUN';
  /** `09:00`. */
  at: string;
  workingDir?: string;
}

/** `MON 09:00` 형태를 파싱한다. */
export function parseSchedule(text: string): { weekday?: ScheduleSpec['weekday']; at: string } | null {
  const m = /^(?:(MON|TUE|WED|THU|FRI|SAT|SUN)\s+)?([01]\d|2[0-3]):([0-5]\d)$/i.exec(text.trim());
  if (!m) return null;
  const weekday = m[1]?.toUpperCase() as ScheduleSpec['weekday'] | undefined;
  return { ...(weekday ? { weekday } : {}), at: `${m[2]}:${m[3]}` };
}

/** Windows 작업 스케줄러 등록 명령. */
export function schtasksCommand(spec: ScheduleSpec): string {
  const parts = [
    'schtasks /Create',
    `/TN "${spec.name}"`,
    `/TR "${spec.command}"`,
    spec.weekday ? `/SC WEEKLY /D ${spec.weekday}` : '/SC DAILY',
    `/ST ${spec.at}`,
    // 배터리로 돌 때도, 화면이 잠겨 있어도 실행되어야 한다.
    '/RL LIMITED',
    '/F',
  ];
  if (spec.user) parts.push(`/RU "${spec.user}"`);
  return parts.join(' ');
}

/** macOS launchd plist. */
export function launchdPlist(spec: ScheduleSpec): string {
  const weekdayMap: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
  const [hour, minute] = spec.at.split(':');
  const calendar = [
    '    <key>StartCalendarInterval</key>',
    '    <dict>',
    spec.weekday ? `      <key>Weekday</key><integer>${weekdayMap[spec.weekday]}</integer>` : '',
    `      <key>Hour</key><integer>${Number(hour)}</integer>`,
    `      <key>Minute</key><integer>${Number(minute)}</integer>`,
    '    </dict>',
  ]
    .filter((l) => l !== '')
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0">',
    '  <dict>',
    `    <key>Label</key><string>${spec.name}</string>`,
    '    <key>ProgramArguments</key>',
    '    <array>',
    ...spec.command.split(' ').map((a) => `      <string>${a}</string>`),
    '    </array>',
    calendar,
    spec.workingDir ? `    <key>WorkingDirectory</key><string>${spec.workingDir}</string>` : '',
    '  </dict>',
    '</plist>',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/** Linux systemd timer 한 쌍. */
export function systemdUnits(spec: ScheduleSpec): { service: string; timer: string } {
  const onCalendar = spec.weekday ? `${spec.weekday.slice(0, 3)} *-*-* ${spec.at}:00` : `*-*-* ${spec.at}:00`;
  return {
    service: [
      '[Unit]',
      `Description=${spec.name}`,
      '',
      '[Service]',
      'Type=oneshot',
      `ExecStart=${spec.command}`,
      spec.workingDir ? `WorkingDirectory=${spec.workingDir}` : '',
      spec.user ? `User=${spec.user}` : '',
    ]
      .filter((l) => l !== '')
      .join('\n'),
    timer: [
      '[Unit]',
      `Description=${spec.name} timer`,
      '',
      '[Timer]',
      `OnCalendar=${onCalendar}`,
      'Persistent=true',
      '',
      '[Install]',
      'WantedBy=timers.target',
    ].join('\n'),
  };
}

export function emitForPlatform(platform: Platform, spec: ScheduleSpec): string {
  if (platform === 'windows') return schtasksCommand(spec);
  if (platform === 'macos') return launchdPlist(spec);
  const units = systemdUnits(spec);
  return `# ${spec.name}.service\n${units.service}\n\n# ${spec.name}.timer\n${units.timer}`;
}

export function currentPlatform(): Platform {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  return 'linux';
}
