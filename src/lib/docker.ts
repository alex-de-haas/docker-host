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
  await new Promise<void>((resolve, reject) => {
    docker.pull(imageTag, (err: Error | null, stream: NodeJS.ReadableStream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });
  return { success: true };
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
