import { getTranslations } from 'next-intl/server';
import { Card } from '@inflect/ui/components/ui/card';
import { StatusBadge } from '@inflect/ui/components/ui/status-badge';
import { Heading } from '@inflect/ui/components/ui/typography';
import { TeamActions } from '@/components/console/team-actions';
import { requireUser } from '@/lib/page-auth';
import { mayDo } from '@/lib/roles';
import { listTeam } from '@/lib/team';

/** The firm's people, for an admin (#145): roles, second factors, and the acts on them. */
export default async function TeamPage() {
  const user = await requireUser();
  const t = await getTranslations();
  if (!mayDo(user.role, 'manageUsers')) {
    return (
      <main className="flex flex-col gap-section">
        <Heading level={1}>{t('team.title')}</Heading>
        <p className="text-content-muted">{t('team.adminOnly')}</p>
      </main>
    );
  }
  const team = await listTeam(user);
  return (
    <main className="flex flex-col gap-section">
      <Heading level={1}>{t('team.title')}</Heading>
      <p className="text-content-muted">{t('team.intro')}</p>
      <Card className="flex flex-col gap-default">
        <div className="overflow-x-auto">
          <table className="data-table" data-testid="team">
            <thead>
              <tr>
                <th scope="col">{t('team.columns.person')}</th>
                <th scope="col">{t('team.columns.role')}</th>
                <th scope="col">{t('team.columns.mfa')}</th>
                <th scope="col">{t('team.columns.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {team.map((member) => (
                <tr key={member.id} data-testid="team-member" data-email={member.email}>
                  <td>
                    <div>{member.name}</div>
                    <div className="text-sm text-content-muted">{member.email}</div>
                    {member.disabledAt ? (
                      <StatusBadge variant="warning" data-testid="member-disabled">
                        {t('team.disabled')}
                      </StatusBadge>
                    ) : null}
                  </td>
                  <td>{t(`nav.roles.${member.role}`)}</td>
                  <td>{t(`team.mfa.${member.mfa}`)}</td>
                  <td>
                    {member.id === user.id ? (
                      <span className="text-sm text-content-muted">{t('team.you')}</span>
                    ) : (
                      <TeamActions userId={member.id} name={member.name} canReset={member.mfa !== 'NOT_REQUIRED'} disabled={member.disabledAt !== null} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </main>
  );
}
