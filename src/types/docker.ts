export interface PortMapping {
  hostPort: number;
  containerPort: number;
  protocol: 'tcp' | 'udp';
}

export interface EnvironmentVariable {
  key: string;
  value: string;
}

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readOnly?: boolean;
}

export interface ContainerConfig {
  id?: string;
  name: string;
  image: string;
  tag: string;
  ports: PortMapping[];
  envVars: EnvironmentVariable[];
  volumes: VolumeMount[];
  autoRestart: boolean;
  network?: string;
}

export interface ContainerStatus {
  id: string;
  name: string;
  image: string;
  status: 'running' | 'stopped' | 'restarting' | 'paused' | 'exited' | 'dead';
  state: string;
  ports: string[];
  created: string;
  uptime?: string;
}

export interface DockerImage {
  id: string;
  repository: string;
  tag: string;
  size: number;
  created: string;
}

export type ContainerAction = 'start' | 'stop' | 'restart' | 'update' | 'remove' | 'logs';

export interface ContainerWithConfig extends ContainerStatus {
  config?: ContainerConfig;
}
