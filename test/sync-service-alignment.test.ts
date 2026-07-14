import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { axiosPostMock } = vi.hoisted(() => ({
  axiosPostMock: vi.fn(),
}));

vi.mock('axios', () => ({
  default: {
    post: axiosPostMock,
  },
}));

import {
  CloudSync,
  MAX_SYNC_EVENT_REQUEST_BYTES,
  MAX_SYNC_EVENT_RESPONSE_BYTES,
} from '../src/sync/service.js';
import { TEMP_USER_ID } from '../src/sync/auth.js';

describe('CloudSync alignment', () => {
  const originalCloudSync = process.env.BROWSER_USE_CLOUD_SYNC;

  beforeEach(() => {
    axiosPostMock.mockReset();
    process.env.BROWSER_USE_CLOUD_SYNC = 'true';
  });

  afterEach(() => {
    if (originalCloudSync === undefined) {
      delete process.env.BROWSER_USE_CLOUD_SYNC;
    } else {
      process.env.BROWSER_USE_CLOUD_SYNC = originalCloudSync;
    }
  });

  it('skips events when cloud sync is disabled', async () => {
    process.env.BROWSER_USE_CLOUD_SYNC = 'false';
    const cloudSync = new CloudSync();

    await cloudSync.handle_event({
      event_type: 'CreateAgentStepEvent',
    } as any);

    expect(axiosPostMock).not.toHaveBeenCalled();
  });

  it('sends events during auth flow when allowSessionEventsForAuth is enabled', async () => {
    const cloudSync = new CloudSync({ allowSessionEventsForAuth: true });
    Object.defineProperty(cloudSync.auth_client, 'is_authenticated', {
      configurable: true,
      get: () => false,
    });

    await cloudSync.handle_event({
      event_type: 'CreateAgentSessionEvent',
      id: 'session-1',
    } as any);

    expect(axiosPostMock).toHaveBeenCalledTimes(1);
    const payload = axiosPostMock.mock.calls[0]?.[1];
    expect(payload.events[0].user_id).toBe(TEMP_USER_ID);
    expect(axiosPostMock.mock.calls[0]?.[2]).toMatchObject({
      maxRedirects: 0,
      maxContentLength: MAX_SYNC_EVENT_RESPONSE_BYTES,
      maxBodyLength: MAX_SYNC_EVENT_REQUEST_BYTES,
    });
  });

  it('does not overwrite explicit temp user_id when authenticated', async () => {
    const cloudSync = new CloudSync({ allowSessionEventsForAuth: true });
    Object.defineProperty(cloudSync.auth_client, 'is_authenticated', {
      configurable: true,
      get: () => true,
    });
    Object.defineProperty(cloudSync.auth_client, 'user_id', {
      configurable: true,
      get: () => 'real-user-id',
    });

    const event = {
      event_type: 'CreateAgentStepEvent',
      user_id: TEMP_USER_ID,
    } as any;

    await cloudSync.handle_event(event);

    expect(axiosPostMock).toHaveBeenCalledTimes(1);
    const payload = axiosPostMock.mock.calls[0]?.[1];
    expect(payload.events[0].user_id).toBe(TEMP_USER_ID);
  });
});
