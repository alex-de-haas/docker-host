import Docker from 'dockerode';
import { buildImageReference, parseImageReference, splitImageReference } from '@/lib/docker-image';

// Create Docker client - connects to local Docker daemon
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

export default docker;

export async function getContainers(all: boolean = true) {
  const containers = await docker.listContainers({ all });
  return containers.map(container => ({
    id: container.Id,
    name: container.Names[0]?.replace(/^\//, '') || 'unnamed',
    image: container.Image,
    status: mapDockerStatus(container.State),
    state: container.State,
    ports: container.Ports.map(p => 
      p.PublicPort ? `${p.PublicPort}:${p.PrivatePort}/${p.Type}` : `${p.PrivatePort}/${p.Type}`
    ),
    created: new Date(container.Created * 1000).toISOString(),
    uptime: container.Status,
  }));
}

export async function getContainer(id: string) {
  const container = docker.getContainer(id);
  const info = await container.inspect();
  const imageReference = splitImageReference(info.Config.Image);
  return {
    id: info.Id,
    name: info.Name.replace(/^\//, ''),
    image: info.Config.Image,
    status: mapDockerStatus(info.State.Status),
    state: info.State.Status,
    ports: Object.entries(info.NetworkSettings.Ports || {}).map(([port, bindings]) => {
      if (bindings && bindings.length > 0) {
        return `${bindings[0].HostPort}:${port}`;
      }
      return port;
    }),
    created: info.Created,
    config: {
      name: info.Name.replace(/^\//, ''),
      image: imageReference.image,
      tag: imageReference.tag,
      ports: Object.entries(info.HostConfig.PortBindings || {}).map(([containerPort, hostBindings]) => {
        const bindings = hostBindings as Array<{ HostPort: string }> | undefined;
        return {
          containerPort: parseInt(containerPort.split('/')[0]),
          hostPort: bindings && bindings[0] ? parseInt(bindings[0].HostPort) : 0,
          protocol: (containerPort.split('/')[1] || 'tcp') as 'tcp' | 'udp',
        };
      }),
      envVars: (info.Config.Env || []).map(env => {
        const [key, ...valueParts] = env.split('=');
        return { key, value: valueParts.join('=') };
      }),
      volumes: Object.entries(info.HostConfig.Binds || []).map((bind) => {
        const parts = (bind[1] as string).split(':');
        return {
          hostPath: parts[0],
          containerPath: parts[1],
          readOnly: parts[2] === 'ro',
        };
      }),
      autoRestart: info.HostConfig.RestartPolicy?.Name !== 'no',
    },
  };
}

export async function startContainer(id: string) {
  const container = docker.getContainer(id);
  await container.start();
  return { success: true };
}

export async function stopContainer(id: string) {
  const container = docker.getContainer(id);
  await container.stop();
  return { success: true };
}

export async function restartContainer(id: string) {
  const container = docker.getContainer(id);
  await container.restart();
  return { success: true };
}

export async function updateContainer(id: string) {
  const container = docker.getContainer(id);
  const info = await container.inspect();
  const imageReference = info.Config.Image;

  await pullImageReference(imageReference);

  const latestImage = await docker.getImage(imageReference).inspect();
  const currentImageId = info.Image;

  if (latestImage.Id === currentImageId) {
    return { success: true, updated: false };
  }

  const originalName = info.Name.replace(/^\//, '');
  const replacementName = `${originalName}-updating-${Date.now()}`;
  const replacement = await docker.createContainer(buildReplacementContainerConfig(info, replacementName));

  let stoppedOriginal = false;
  let removedOriginal = false;
  let renamedReplacement = false;

  try {
    await connectSecondaryNetworks(replacement, info);

    if (info.State.Running) {
      await container.stop();
      stoppedOriginal = true;
    }

    await container.remove();
    removedOriginal = true;

    await replacement.rename({ name: originalName });
    renamedReplacement = true;

    if (info.State.Running) {
      await replacement.start();
    }

    return { success: true, updated: true };
  } catch (error) {
    if (!removedOriginal) {
      if (stoppedOriginal && info.State.Running) {
        await container.start().catch(() => undefined);
      }

      await replacement.remove({ force: true }).catch(() => undefined);
    } else if (!renamedReplacement) {
      await replacement.remove({ force: true }).catch(() => undefined);
    }

    throw error;
  }
}

export async function removeContainer(id: string, force: boolean = false) {
  const container = docker.getContainer(id);
  await container.remove({ force });
  return { success: true };
}

export async function getContainerLogs(id: string, tail: number = 100) {
  const container = docker.getContainer(id);
  const logs = await container.logs({
    stdout: true,
    stderr: true,
    tail,
    timestamps: true,
  });
  return logs.toString('utf-8');
}

export async function createAndStartContainer(config: {
  name: string;
  image: string;
  tag: string;
  ports: Array<{ hostPort: number; containerPort: number; protocol: string }>;
  envVars: Array<{ key: string; value: string }>;
  volumes: Array<{ hostPath: string; containerPath: string; readOnly?: boolean }>;
  autoRestart: boolean;
  network?: string;
}) {
  const imageTag = buildImageReference(config.image, config.tag);
  
  // Pull image if not exists
  try {
    await docker.getImage(imageTag).inspect();
  } catch {
    await new Promise<void>((resolve, reject) => {
      docker.pull(imageTag, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (err: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });
  }

  // Build port bindings
  const exposedPorts: Record<string, object> = {};
  const portBindings: Record<string, Array<{ HostPort: string }>> = {};
  
  config.ports.forEach(p => {
    const containerPort = `${p.containerPort}/${p.protocol || 'tcp'}`;
    exposedPorts[containerPort] = {};
    portBindings[containerPort] = [{ HostPort: String(p.hostPort) }];
  });

  // Build volume bindings
  const binds = config.volumes.map(v => 
    `${v.hostPath}:${v.containerPath}${v.readOnly ? ':ro' : ''}`
  );

  // Create container
  const container = await docker.createContainer({
    name: config.name,
    Image: imageTag,
    ExposedPorts: exposedPorts,
    Env: config.envVars.map(e => `${e.key}=${e.value}`),
    HostConfig: {
      PortBindings: portBindings,
      Binds: binds,
      RestartPolicy: config.autoRestart ? { Name: 'unless-stopped' } : { Name: 'no' },
      NetworkMode: config.network || 'bridge',
    },
  });

  await container.start();
  return { id: container.id, success: true };
}

export async function getImages() {
  const images = await docker.listImages();
  return images.map(img => {
    const primaryTag = img.RepoTags?.[0] || '<none>';
    const imageReference = parseImageReference(primaryTag);

    return {
      id: img.Id,
      repository: imageReference.name || '<none>',
      tag: imageReference.digest ? `@${imageReference.digest}` : imageReference.tag || '<none>',
      size: img.Size,
      created: new Date(img.Created * 1000).toISOString(),
    };
  });
}

export async function pullImage(image: string, tag: string = 'latest') {
  const imageTag = buildImageReference(image, tag);
  await pullImageReference(imageTag);
  return { success: true };
}

async function pullImageReference(imageReference: string) {
  await new Promise<void>((resolve, reject) => {
    docker.pull(imageReference, (err: Error | null, stream: NodeJS.ReadableStream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

function buildReplacementContainerConfig(
  info: Docker.ContainerInspectInfo,
  name: string
): Docker.ContainerCreateOptions {
  const mountConfigs = buildMountConfigs(info);
  const endpointConfigs = buildEndpointConfigs(info);

  const networkMode = normalizeNetworkMode(info.HostConfig.NetworkMode);
  const primaryNetwork = getPrimaryNetworkName(networkMode, endpointConfigs);

  if (primaryNetwork) {
    delete endpointConfigs[primaryNetwork];
  }

  return {
    name,
    platform: info.Platform || undefined,
    Hostname: info.Config.Hostname,
    Domainname: info.Config.Domainname,
    User: info.Config.User,
    AttachStdin: info.Config.AttachStdin,
    AttachStdout: info.Config.AttachStdout,
    AttachStderr: info.Config.AttachStderr,
    Tty: info.Config.Tty,
    OpenStdin: info.Config.OpenStdin,
    StdinOnce: info.Config.StdinOnce,
    Env: info.Config.Env,
    Cmd: info.Config.Cmd,
    Entrypoint: info.Config.Entrypoint,
    Image: info.Config.Image,
    Labels: info.Config.Labels,
    Volumes: info.Config.Volumes,
    WorkingDir: info.Config.WorkingDir,
    ExposedPorts: info.Config.ExposedPorts,
    Healthcheck: info.Config.Healthcheck,
    HostConfig: {
      AutoRemove: info.HostConfig.AutoRemove,
      Binds: mountConfigs.length === 0 ? info.HostConfig.Binds : undefined,
      LogConfig: info.HostConfig.LogConfig,
      NetworkMode: networkMode,
      PortBindings: info.HostConfig.PortBindings,
      RestartPolicy: info.HostConfig.RestartPolicy,
      VolumeDriver: info.HostConfig.VolumeDriver,
      VolumesFrom: info.HostConfig.VolumesFrom,
      Mounts: mountConfigs.length > 0 ? mountConfigs : undefined,
      CapAdd: info.HostConfig.CapAdd,
      CapDrop: info.HostConfig.CapDrop,
      Dns: info.HostConfig.Dns,
      DnsOptions: info.HostConfig.DnsOptions,
      DnsSearch: info.HostConfig.DnsSearch,
      ExtraHosts: info.HostConfig.ExtraHosts,
      GroupAdd: info.HostConfig.GroupAdd,
      IpcMode: info.HostConfig.IpcMode,
      Cgroup: info.HostConfig.Cgroup,
      Links: info.HostConfig.Links,
      OomScoreAdj: info.HostConfig.OomScoreAdj,
      PidMode: info.HostConfig.PidMode,
      Privileged: info.HostConfig.Privileged,
      PublishAllPorts: info.HostConfig.PublishAllPorts,
      ReadonlyRootfs: info.HostConfig.ReadonlyRootfs,
      SecurityOpt: info.HostConfig.SecurityOpt,
      StorageOpt: info.HostConfig.StorageOpt,
      Tmpfs: info.HostConfig.Tmpfs,
      UTSMode: info.HostConfig.UTSMode,
      UsernsMode: info.HostConfig.UsernsMode,
      ShmSize: info.HostConfig.ShmSize,
      Sysctls: info.HostConfig.Sysctls,
      Runtime: info.HostConfig.Runtime,
      ConsoleSize: info.HostConfig.ConsoleSize,
      Isolation: info.HostConfig.Isolation,
      MaskedPaths: info.HostConfig.MaskedPaths,
      ReadonlyPaths: info.HostConfig.ReadonlyPaths,
      CpuShares: info.HostConfig.CpuShares,
      CgroupParent: info.HostConfig.CgroupParent,
      BlkioWeight: info.HostConfig.BlkioWeight,
      BlkioWeightDevice: info.HostConfig.BlkioWeightDevice,
      BlkioDeviceReadBps: info.HostConfig.BlkioDeviceReadBps,
      BlkioDeviceWriteBps: info.HostConfig.BlkioDeviceWriteBps,
      BlkioDeviceReadIOps: info.HostConfig.BlkioDeviceReadIOps,
      BlkioDeviceWriteIOps: info.HostConfig.BlkioDeviceWriteIOps,
      CpuPeriod: info.HostConfig.CpuPeriod,
      CpuQuota: info.HostConfig.CpuQuota,
      CpusetCpus: info.HostConfig.CpusetCpus,
      CpusetMems: info.HostConfig.CpusetMems,
      Devices: info.HostConfig.Devices,
      DeviceCgroupRules: info.HostConfig.DeviceCgroupRules,
      DeviceRequests: info.HostConfig.DeviceRequests,
      DiskQuota: info.HostConfig.DiskQuota,
      KernelMemory: info.HostConfig.KernelMemory,
      Memory: info.HostConfig.Memory,
      MemoryReservation: info.HostConfig.MemoryReservation,
      MemorySwap: info.HostConfig.MemorySwap,
      MemorySwappiness: info.HostConfig.MemorySwappiness,
      NanoCpus: info.HostConfig.NanoCpus,
      OomKillDisable: info.HostConfig.OomKillDisable,
      Init: info.HostConfig.Init,
      PidsLimit: info.HostConfig.PidsLimit,
      Ulimits: info.HostConfig.Ulimits,
      CpuCount: info.HostConfig.CpuCount,
      CpuPercent: info.HostConfig.CpuPercent,
      CpuRealtimePeriod: info.HostConfig.CpuRealtimePeriod,
      CpuRealtimeRuntime: info.HostConfig.CpuRealtimeRuntime,
    },
    NetworkingConfig:
      Object.keys(endpointConfigs).length > 0
        ? { EndpointsConfig: endpointConfigs }
        : undefined,
  };
}

function buildMountConfigs(info: Docker.ContainerInspectInfo): Docker.MountConfig {
  return info.Mounts.filter(isSupportedMount).map(mount => ({
    Type: mount.Type,
    Source: mount.Type === 'volume' && mount.Name ? mount.Name : mount.Source,
    Target: mount.Destination,
    ReadOnly: !mount.RW,
    BindOptions:
      mount.Type === 'bind' && mount.Propagation
        ? { Propagation: mount.Propagation as Docker.MountPropagation }
        : undefined,
  }));
}

function isSupportedMount(
  mount: Docker.ContainerInspectInfo['Mounts'][number]
): mount is Docker.ContainerInspectInfo['Mounts'][number] & { Type: Docker.MountType } {
  return (
    mount.Type === 'bind' ||
    mount.Type === 'volume' ||
    mount.Type === 'tmpfs' ||
    mount.Type === 'image'
  );
}

function buildEndpointConfigs(info: Docker.ContainerInspectInfo): Docker.EndpointsConfig {
  return Object.fromEntries(
    Object.entries(info.NetworkSettings.Networks || {}).map(([networkName, settings]) => [
      networkName,
      {
        Aliases: settings.Aliases,
        Links: settings.Links,
        IPAMConfig: settings.IPAMConfig,
        MacAddress: settings.MacAddress,
      },
    ])
  );
}

function getPrimaryNetworkName(
  networkMode: string | undefined,
  endpointConfigs: Docker.EndpointsConfig
) {
  if (!networkMode || networkMode === 'default') {
    return 'bridge' in endpointConfigs ? 'bridge' : undefined;
  }

  if (networkMode.startsWith('container:') || networkMode === 'host' || networkMode === 'none') {
    return undefined;
  }

  return networkMode in endpointConfigs ? networkMode : undefined;
}

function normalizeNetworkMode(networkMode?: string) {
  if (!networkMode) {
    return undefined;
  }

  return networkMode === 'default' ? 'bridge' : networkMode;
}

async function connectSecondaryNetworks(
  container: Docker.Container,
  info: Docker.ContainerInspectInfo
) {
  const primaryNetwork = getPrimaryNetworkName(
    normalizeNetworkMode(info.HostConfig.NetworkMode),
    buildEndpointConfigs(info)
  );

  for (const [networkName, settings] of Object.entries(info.NetworkSettings.Networks || {})) {
    if (networkName === primaryNetwork) {
      continue;
    }

    await docker.getNetwork(networkName).connect({
      Container: container.id,
      EndpointConfig: {
        Aliases: settings.Aliases,
        Links: settings.Links,
        IPAMConfig: settings.IPAMConfig,
        MacAddress: settings.MacAddress,
      },
    });
  }
}

function mapDockerStatus(state: string): 'running' | 'stopped' | 'restarting' | 'paused' | 'exited' | 'dead' {
  switch (state.toLowerCase()) {
    case 'running':
      return 'running';
    case 'restarting':
      return 'restarting';
    case 'paused':
      return 'paused';
    case 'exited':
      return 'exited';
    case 'dead':
      return 'dead';
    default:
      return 'stopped';
  }
}
