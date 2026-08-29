export function isLiveBatchOwner(createdBy, viewerUserId) {
    const ownerId = Number(createdBy);
    const userId = Number(viewerUserId);
    return Number.isSafeInteger(ownerId) && ownerId > 0
        && Number.isSafeInteger(userId) && userId > 0
        && ownerId === userId;
}
