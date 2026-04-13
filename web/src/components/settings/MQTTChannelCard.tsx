import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { toast } from 'sonner';

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { api } from '../../api/client';
import { getErrorMessage } from './types';

interface UserMQTTConfig {
  brokerUrl: string;
  clientId: string;
  subscribeTopic: string;
  username: string;
  hasPassword: boolean;
  enabled: boolean;
  connected: boolean;
  updatedAt: string | null;
}

export function MQTTChannelCard() {
  const [config, setConfig] = useState<UserMQTTConfig | null>(null);
  const [brokerUrl, setBrokerUrl] = useState('');
  const [clientId, setClientId] = useState('');
  const [subscribeTopic, setSubscribeTopic] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [toggling, setToggling] = useState(false);

  const enabled = config?.enabled ?? false;

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<UserMQTTConfig>('/api/config/user-im/mqtt');
      setConfig(data);
      setBrokerUrl(data.brokerUrl || '');
      setClientId(data.clientId || '');
      setSubscribeTopic(data.subscribeTopic || '');
      setUsername(data.username || '');
      setPassword('');
    } catch {
      setConfig(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const handleToggle = async (newEnabled: boolean) => {
    setToggling(true);
    try {
      const data = await api.put<UserMQTTConfig>(
        '/api/config/user-im/mqtt',
        { enabled: newEnabled },
      );
      setConfig(data);
      toast.success(`MQTT 渠道已${newEnabled ? '启用' : '停用'}`);
    } catch (err) {
      toast.error(getErrorMessage(err, '切换 MQTT 渠道状态失败'));
    } finally {
      setToggling(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const url = brokerUrl.trim();
      const id = clientId.trim();

      if (!url || !id) {
        toast.error('Broker 地址和 Agent 名称不能为空');
        setSaving(false);
        return;
      }

      const payload: Record<string, string | boolean> = {
        enabled: true,
        brokerUrl: url,
        clientId: id,
      };
      const topic = subscribeTopic.trim();
      if (topic) payload.subscribeTopic = topic;
      if (username.trim()) payload.username = username.trim();
      if (password.trim()) payload.password = password.trim();

      const data = await api.put<UserMQTTConfig>(
        '/api/config/user-im/mqtt',
        payload,
      );
      setConfig(data);
      setPassword('');
      toast.success('MQTT 配置已保存');
    } catch (err) {
      toast.error(getErrorMessage(err, '保存 MQTT 配置失败'));
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      await api.post('/api/config/user-im/mqtt/test');
      toast.success('MQTT 连接测试成功');
    } catch (err) {
      toast.error(getErrorMessage(err, 'MQTT 连接测试失败'));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 bg-slate-50/50">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block w-2 h-2 rounded-full ${config?.connected ? 'bg-emerald-500' : 'bg-slate-300'}`}
          />
          <div>
            <h3 className="text-sm font-semibold text-slate-800">MQTT</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              通过 MQTT Broker 与其他 Agent 通信
            </p>
          </div>
        </div>
        <Switch
          checked={enabled}
          disabled={loading || toggling}
          onCheckedChange={handleToggle}
        />
      </div>

      <div
        className={`px-5 py-4 space-y-4 transition-opacity ${!enabled ? 'opacity-50 pointer-events-none' : ''}`}
      >
        {loading ? (
          <div className="text-sm text-slate-500">加载中...</div>
        ) : (
          <>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-slate-500 mb-1">
                  Broker 地址
                </label>
                <Input
                  type="text"
                  value={brokerUrl}
                  onChange={(e) => setBrokerUrl(e.target.value)}
                  placeholder="mqtt://192.168.50.75:1883"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">
                  Agent 名称（唯一标识）
                </label>
                <Input
                  type="text"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder="agent-mini-happyclaw"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">
                  订阅 Topic（留空自动生成）
                </label>
                <Input
                  type="text"
                  value={subscribeTopic}
                  onChange={(e) => setSubscribeTopic(e.target.value)}
                  placeholder={`agents/${clientId || '{agent-name}'}/#`}
                />
              </div>
              <div className="grid md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-slate-500 mb-1">
                    用户名（可选）
                  </label>
                  <Input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="留空则匿名连接"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">
                    密码（可选）
                  </label>
                  <Input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={
                      config?.hasPassword ? '留空不修改' : '留空则匿名连接'
                    }
                  />
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={handleSave} disabled={saving}>
                {saving && <Loader2 className="size-4 animate-spin" />}
                保存 MQTT 配置
              </Button>
              <Button
                variant="outline"
                onClick={handleTest}
                disabled={testing || !brokerUrl.trim()}
              >
                {testing && <Loader2 className="size-4 animate-spin" />}
                测试连接
              </Button>
            </div>

            <div className="text-xs text-slate-400 mt-2">
              <p>
                消息格式：{`{"id":"uuid","from":"agent-name","text":"...","ts":毫秒时间戳}`}
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
