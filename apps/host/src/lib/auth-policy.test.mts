import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canAccessModule,
  canUseHostApi,
  DEFAULT_MODULE_EXPOSURE_POLICY,
} from './auth-policy.ts';
import type { HostPrincipal } from '../types/auth.ts';

const admin: HostPrincipal = {
  id: 'user_admin',
  role: 'host.admin',
  email: 'admin@example.test',
};

const user: HostPrincipal = {
  id: 'user_regular',
  role: 'host.user',
  email: 'user@example.test',
};

test('only host admins can use Host API actions', () => {
  assert.equal(canUseHostApi(admin, 'modules.install'), true);
  assert.equal(canUseHostApi(user, 'host.read'), false);
  assert.equal(canUseHostApi(null, 'host.read'), false);
});

test('module exposure defaults to login required', () => {
  assert.equal(DEFAULT_MODULE_EXPOSURE_POLICY, 'loginRequired');

  assert.deepEqual(
    canAccessModule({
      principal: null,
      moduleId: 'com.example.reports',
    }),
    {
      allowed: false,
      policy: 'loginRequired',
      reason: 'loginRequired',
    }
  );
});

test('public modules are reachable without a Host session', () => {
  assert.deepEqual(
    canAccessModule({
      principal: null,
      moduleId: 'com.example.reports',
      exposurePolicy: 'public',
    }),
    {
      allowed: true,
      policy: 'public',
      reason: 'public',
    }
  );
});

test('login required modules are reachable by any authenticated Host user', () => {
  assert.deepEqual(
    canAccessModule({
      principal: user,
      moduleId: 'com.example.reports',
      exposurePolicy: 'loginRequired',
    }),
    {
      allowed: true,
      policy: 'loginRequired',
      reason: 'authenticated',
    }
  );
});

test('assigned modules require assignment for host users', () => {
  assert.deepEqual(
    canAccessModule({
      principal: user,
      moduleId: 'com.example.reports',
      exposurePolicy: 'assignedUsersOnly',
      assignments: [],
    }),
    {
      allowed: false,
      policy: 'assignedUsersOnly',
      reason: 'assignmentRequired',
    }
  );

  assert.deepEqual(
    canAccessModule({
      principal: user,
      moduleId: 'com.example.reports',
      exposurePolicy: 'assignedUsersOnly',
      assignments: [{ moduleId: 'com.example.reports', userId: user.id }],
    }),
    {
      allowed: true,
      policy: 'assignedUsersOnly',
      reason: 'assigned',
    }
  );
});

test('host admins can reach assigned modules for bootstrap and configuration', () => {
  assert.deepEqual(
    canAccessModule({
      principal: admin,
      moduleId: 'com.example.reports',
      exposurePolicy: 'assignedUsersOnly',
      assignments: [],
    }),
    {
      allowed: true,
      policy: 'assignedUsersOnly',
      reason: 'hostAdmin',
    }
  );
});

