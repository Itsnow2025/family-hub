import { Button, Card, fieldClass, Heading, Nav, Page } from "@/components/ui";
import { requireMember } from "@/lib/session";
import { addItems, createList, setItemStatus } from "./actions";

export default async function ListsPage() {
  const { hub, me } = await requireMember("/lists");
  const [members, lists] = await Promise.all([hub.members(), hub.lists()]);
  const withItems = await Promise.all(
    lists.map(async (list) => ({ list, items: await hub.listItems(list.id, { includeGot: true }) })),
  );

  return (
    <>
      <Nav me={me} members={members} current="lists" />
      <Page>
        <Heading sub='Add by typing here, or tell your AI "add milk to the shopping list".'>Lists</Heading>

        {withItems.map(({ list, items }) => {
          const needed = items.filter((i) => i.status === "needed");
          const got = items.filter((i) => i.status === "got");
          return (
            <Card key={list.id} className="mb-4">
              <div className="mb-3 flex items-baseline justify-between">
                <h2 className="text-lg font-semibold">{list.name}</h2>
                <span className="text-sm text-muted">{needed.length ? `${needed.length} to get` : "all done"}</span>
              </div>

              <form action={addItems} className="mb-3 flex gap-2">
                <input type="hidden" name="list_id" value={list.id} />
                <input
                  name="items"
                  required
                  maxLength={1000}
                  className={fieldClass}
                  placeholder="Add something, or a few with commas"
                  autoComplete="off"
                />
                <Button type="submit">Add</Button>
              </form>

              {needed.length ? (
                <ul>
                  {needed.map((item) => (
                    <li key={item.id} className="flex items-center gap-2 border-t border-line py-2">
                      <form action={setItemStatus} className="flex-1">
                        <input type="hidden" name="id" value={item.id} />
                        <input type="hidden" name="status" value="got" />
                        <button className="flex min-h-11 w-full items-center gap-3 rounded-lg px-1 text-left hover:bg-background">
                          <span aria-hidden className="h-5 w-5 shrink-0 rounded-md border-2 border-accent" />
                          <span className="flex-1">
                            {item.item}
                            {item.addedBy ? <span className="ml-2 text-xs text-muted">{item.addedBy}</span> : null}
                          </span>
                          <span className="sr-only">Mark as got</span>
                        </button>
                      </form>
                      <form action={setItemStatus}>
                        <input type="hidden" name="id" value={item.id} />
                        <input type="hidden" name="status" value="removed" />
                        <button className="rounded-lg px-2 py-1 text-xs text-muted hover:bg-background" aria-label={`Take ${item.item} off the list`}>
                          Remove
                        </button>
                      </form>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted">Nothing to get.</p>
              )}

              {got.length ? (
                <details className="mt-3">
                  <summary className="cursor-pointer text-sm text-muted">Got in the last week ({got.length})</summary>
                  <ul className="mt-1">
                    {got.map((item) => (
                      <li key={item.id} className="flex items-center gap-2 py-1 text-sm text-muted">
                        <span className="flex-1 line-through">{item.item}</span>
                        <form action={setItemStatus}>
                          <input type="hidden" name="id" value={item.id} />
                          <input type="hidden" name="status" value="needed" />
                          <button className="rounded-lg px-2 py-1 text-xs hover:bg-background">Put back</button>
                        </form>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </Card>
          );
        })}

        <Card>
          <h2 className="mb-2 text-sm font-medium text-muted">Start another list</h2>
          <form action={createList} className="flex gap-2">
            <input name="name" required maxLength={60} className={fieldClass} placeholder="Such as Hardware, or Feed store" autoComplete="off" />
            <Button type="submit" kind="quiet">
              Start
            </Button>
          </form>
        </Card>
      </Page>
    </>
  );
}
