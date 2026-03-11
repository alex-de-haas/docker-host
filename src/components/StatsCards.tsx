'use client';

import { motion } from 'framer-motion';
import { Container, Server, Activity, HardDrive } from 'lucide-react';
import { ContainerStatus } from '@/types/docker';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface StatsCardsProps {
  containers: ContainerStatus[];
}

export function StatsCards({ containers }: StatsCardsProps) {
  const running = containers.filter(c => c.status === 'running').length;
  const stopped = containers.filter(c => c.status !== 'running').length;
  const total = containers.length;

  const stats = [
    {
      title: 'Total Containers',
      value: total,
      icon: Container,
      color: 'text-blue-500',
      bg: 'bg-blue-500/10',
    },
    {
      title: 'Running',
      value: running,
      icon: Activity,
      color: 'text-emerald-500',
      bg: 'bg-emerald-500/10',
    },
    {
      title: 'Stopped',
      value: stopped,
      icon: Server,
      color: 'text-zinc-500',
      bg: 'bg-zinc-500/10',
    },
    {
      title: 'Images',
      value: new Set(containers.map(c => c.image)).size,
      icon: HardDrive,
      color: 'text-purple-500',
      bg: 'bg-purple-500/10',
    },
  ];

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      {stats.map((stat, index) => (
        <motion.div
          key={stat.title}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: index * 0.1 }}
        >
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">{stat.title}</CardTitle>
              <div className={`p-2 rounded-lg ${stat.bg}`}>
                <stat.icon className={`h-4 w-4 ${stat.color}`} />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stat.value}</div>
            </CardContent>
          </Card>
        </motion.div>
      ))}
    </div>
  );
}
