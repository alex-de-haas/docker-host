'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, X } from 'lucide-react';
import { ContainerConfig, PortMapping, EnvironmentVariable, VolumeMount } from '@/types/docker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DEFAULT_IMAGE_TAG } from '@/lib/docker-image';

interface CreateContainerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (config: ContainerConfig) => Promise<boolean>;
}

const defaultPort: PortMapping = { hostPort: 8080, containerPort: 80, protocol: 'tcp' };
const defaultEnvVar: EnvironmentVariable = { key: '', value: '' };
const defaultVolume: VolumeMount = { hostPath: '', containerPath: '' };

export function CreateContainerDialog({ open, onOpenChange, onCreate }: CreateContainerDialogProps) {
  const [loading, setLoading] = useState(false);
  const [config, setConfig] = useState<ContainerConfig>({
    name: '',
    image: '',
    tag: DEFAULT_IMAGE_TAG,
    ports: [{ ...defaultPort }],
    envVars: [],
    volumes: [],
    autoRestart: true,
  });

  const updateConfig = <K extends keyof ContainerConfig>(key: K, value: ContainerConfig[K]) => {
    setConfig(prev => ({ ...prev, [key]: value }));
  };

  const addPort = () => {
    updateConfig('ports', [...config.ports, { ...defaultPort, hostPort: 8080 + config.ports.length }]);
  };

  const removePort = (index: number) => {
    updateConfig('ports', config.ports.filter((_, i) => i !== index));
  };

  const updatePort = (index: number, field: keyof PortMapping, value: string | number) => {
    const newPorts = [...config.ports];
    if (field === 'protocol') {
      newPorts[index] = { ...newPorts[index], [field]: value as 'tcp' | 'udp' };
    } else {
      newPorts[index] = { ...newPorts[index], [field]: Number(value) };
    }
    updateConfig('ports', newPorts);
  };

  const addEnvVar = () => {
    updateConfig('envVars', [...config.envVars, { ...defaultEnvVar }]);
  };

  const removeEnvVar = (index: number) => {
    updateConfig('envVars', config.envVars.filter((_, i) => i !== index));
  };

  const updateEnvVar = (index: number, field: keyof EnvironmentVariable, value: string) => {
    const newEnvVars = [...config.envVars];
    newEnvVars[index] = { ...newEnvVars[index], [field]: value };
    updateConfig('envVars', newEnvVars);
  };

  const addVolume = () => {
    updateConfig('volumes', [...config.volumes, { ...defaultVolume }]);
  };

  const removeVolume = (index: number) => {
    updateConfig('volumes', config.volumes.filter((_, i) => i !== index));
  };

  const updateVolume = (index: number, field: keyof VolumeMount, value: string | boolean) => {
    const newVolumes = [...config.volumes];
    newVolumes[index] = { ...newVolumes[index], [field]: value };
    updateConfig('volumes', newVolumes);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    const success = await onCreate(config);
    setLoading(false);
    if (success) {
      onOpenChange(false);
      setConfig({
        name: '',
        image: '',
        tag: DEFAULT_IMAGE_TAG,
        ports: [{ ...defaultPort }],
        envVars: [],
        volumes: [],
        autoRestart: true,
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create New Container</DialogTitle>
          <DialogDescription>
            Configure and deploy a new Docker container from any registry-backed image.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Basic Info */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">Basic Information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">Container Name</Label>
                <Input
                  id="name"
                  placeholder="my-app"
                  value={config.name}
                  onChange={(e) => updateConfig('name', e.target.value)}
                  required
                />
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div className="col-span-2 space-y-2">
                  <Label htmlFor="image">Image</Label>
                  <Input
                    id="image"
                    placeholder="nginx or ghcr.io/owner/image"
                    value={config.image}
                    onChange={(e) => updateConfig('image', e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="tag">Tag</Label>
                  <Input
                    id="tag"
                    placeholder="latest"
                    value={config.tag}
                    onChange={(e) => updateConfig('tag', e.target.value)}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Supports Docker Hub, GitHub Container Registry and other registries. Example:
                {' '}<code>ghcr.io/owner/image:latest</code> or <code>ghcr.io/owner/image</code> plus a tag.
              </p>
            </CardContent>
          </Card>

          {/* Port Mappings */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium">Port Mappings</CardTitle>
                <Button type="button" variant="outline" size="sm" onClick={addPort}>
                  <Plus className="h-4 w-4 mr-1" /> Add Port
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <AnimatePresence>
                {config.ports.map((port, index) => (
                  <motion.div
                    key={index}
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="flex items-center gap-2"
                  >
                    <Input
                      type="number"
                      placeholder="Host Port"
                      value={port.hostPort}
                      onChange={(e) => updatePort(index, 'hostPort', e.target.value)}
                      className="w-28"
                    />
                    <span className="text-muted-foreground">:</span>
                    <Input
                      type="number"
                      placeholder="Container Port"
                      value={port.containerPort}
                      onChange={(e) => updatePort(index, 'containerPort', e.target.value)}
                      className="w-28"
                    />
                    <select
                      value={port.protocol}
                      onChange={(e) => updatePort(index, 'protocol', e.target.value)}
                      className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                    >
                      <option value="tcp">TCP</option>
                      <option value="udp">UDP</option>
                    </select>
                    {config.ports.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => removePort(index)}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    )}
                  </motion.div>
                ))}
              </AnimatePresence>
            </CardContent>
          </Card>

          {/* Environment Variables */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium">Environment Variables</CardTitle>
                <Button type="button" variant="outline" size="sm" onClick={addEnvVar}>
                  <Plus className="h-4 w-4 mr-1" /> Add Variable
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <AnimatePresence>
                {config.envVars.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No environment variables configured.</p>
                ) : (
                  config.envVars.map((envVar, index) => (
                    <motion.div
                      key={index}
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className="flex items-center gap-2"
                    >
                      <Input
                        placeholder="KEY"
                        value={envVar.key}
                        onChange={(e) => updateEnvVar(index, 'key', e.target.value)}
                        className="flex-1"
                      />
                      <span className="text-muted-foreground">=</span>
                      <Input
                        placeholder="value"
                        value={envVar.value}
                        onChange={(e) => updateEnvVar(index, 'value', e.target.value)}
                        className="flex-1"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => removeEnvVar(index)}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </motion.div>
                  ))
                )}
              </AnimatePresence>
            </CardContent>
          </Card>

          {/* Volume Mounts */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium">Volume Mounts</CardTitle>
                <Button type="button" variant="outline" size="sm" onClick={addVolume}>
                  <Plus className="h-4 w-4 mr-1" /> Add Volume
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <AnimatePresence>
                {config.volumes.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No volumes configured.</p>
                ) : (
                  config.volumes.map((volume, index) => (
                    <motion.div
                      key={index}
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className="flex items-center gap-2"
                    >
                      <Input
                        placeholder="/host/path"
                        value={volume.hostPath}
                        onChange={(e) => updateVolume(index, 'hostPath', e.target.value)}
                        className="flex-1"
                      />
                      <span className="text-muted-foreground">→</span>
                      <Input
                        placeholder="/container/path"
                        value={volume.containerPath}
                        onChange={(e) => updateVolume(index, 'containerPath', e.target.value)}
                        className="flex-1"
                      />
                      <label className="flex items-center gap-1 text-sm">
                        <input
                          type="checkbox"
                          checked={volume.readOnly || false}
                          onChange={(e) => updateVolume(index, 'readOnly', e.target.checked)}
                        />
                        RO
                      </label>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => removeVolume(index)}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </motion.div>
                  ))
                )}
              </AnimatePresence>
            </CardContent>
          </Card>

          {/* Options */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">Options</CardTitle>
            </CardHeader>
            <CardContent>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={config.autoRestart}
                  onChange={(e) => updateConfig('autoRestart', e.target.checked)}
                  className="rounded"
                />
                <span className="text-sm">Auto-restart on failure</span>
              </label>
            </CardContent>
          </Card>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading || !config.name || !config.image}>
              {loading ? 'Creating...' : 'Create Container'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
