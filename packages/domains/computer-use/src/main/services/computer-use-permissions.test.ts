import { beforeEach, describe, expect, it, vi } from 'vitest'
import { shell } from 'electron'
import {
  MACOS_SCREEN_RECORDING_SETTINGS_URL,
  openSystemSettingsPane
} from './computer-use-permissions'

vi.mock('electron', () => ({
  desktopCapturer: { getSources: vi.fn(async () => []) },
  shell: { openExternal: vi.fn(async () => undefined) },
  systemPreferences: {
    getMediaAccessStatus: vi.fn(() => 'not-determined'),
    isTrustedAccessibilityClient: vi.fn(() => false)
  }
}))

describe('computer-use permission system settings policy', () => {
  beforeEach(() => vi.mocked(shell.openExternal).mockClear())

  it('opens only the exact allowlisted macOS system settings pane', async () => {
    await openSystemSettingsPane(MACOS_SCREEN_RECORDING_SETTINGS_URL)
    expect(shell.openExternal).toHaveBeenCalledWith(MACOS_SCREEN_RECORDING_SETTINGS_URL)
    await expect(openSystemSettingsPane(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'
    )).rejects.toThrow(/Unsupported system settings URL/)
    expect(shell.openExternal).toHaveBeenCalledTimes(1)
  })
})
